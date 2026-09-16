// Lazy-loaded 3D LiDAR inspection module -- imported only when the user
// clicks "Inspect LiDAR in 3D", so its (deck.gl-based) dependency cost is
// never paid on normal Timber Radar startup.
//
// TV25-32 status (2026-09-16): real production point-cloud streaming,
// implemented directly in the Timber Radar MapLibre application (no
// separate demo site). Renderer: maplibre-gl-lidar (EPT streaming via
// deck.gl), loaded from esm.sh at first use. Source: the SAME public USGS
// 3DEP EPT acquisition (OH_Statewide_Phase2_6_2020) already used by the
// analysis pipeline -- verified working via bounded streaming reads
// (real points loaded, never the full 69B-point dataset). COPC fallback
// is not yet wired in (EPT passed its own hard requirements on first try,
// per LIDAR_3D_SPEC.md Section 53 -- "if EPT passes, continue with EPT").

const LIDAR_MODULE_URL = "https://esm.sh/maplibre-gl-lidar@0.17.0";
const EPT_SOURCE_URL = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/OH_Statewide_Phase2_6_2020/ept.json";
const DESKTOP_POINT_BUDGET = 2_000_000;
const MOBILE_POINT_BUDGET = 400_000;
const PARCEL_MARGIN_M = 20;
const MOBILE_WIDTH_BREAKPOINT = 700;

let lidarModulePromise = null;
let lidarControl = null;
let previousCameraState = null;
let currentCloudId = null;

function pickPointBudget() {
  return window.innerWidth < MOBILE_WIDTH_BREAKPOINT ? MOBILE_POINT_BUDGET : DESKTOP_POINT_BUDGET;
}

async function getLidarModule() {
  if (!lidarModulePromise) lidarModulePromise = import(LIDAR_MODULE_URL);
  return lidarModulePromise;
}

function getOrCreateControl(map, mod) {
  if (lidarControl) return lidarControl;
  lidarControl = new mod.LidarControl({
    pointBudget: pickPointBudget(),
    colorRange: { mode: "percentile", percentileLow: 2, percentileHigh: 98 },
  });
  map.addControl(lidarControl, "top-right");
  // The library ships its own full generic panel (metadata, cross-section,
  // classification toggles, etc.); Timber Radar exposes only what the
  // product needs through its own modal, so the library's own panel stays
  // hidden rather than stacking two competing UIs (PERFORMANCE_BUDGET.md
  // / UX polish: "avoid overwhelming the user with the library's full
  // generic control panel").
  const container = lidarControl.getContainer?.();
  if (container) container.style.display = "none";
  try {
    lidarControl.setColorScheme("elevation");
    lidarControl.setColormap("terrain");
  } catch (e) {
    console.warn("LiDAR color scheme not applied:", e);
  }
  return lidarControl;
}

function metersToDegreesLat(m) {
  return m / 111320;
}
function metersToDegreesLon(m, atLat) {
  return m / (111320 * Math.cos((atLat * Math.PI) / 180));
}

function bboxFromCoords(coords, marginM) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of coords) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  const midLat = (south + north) / 2;
  const dLon = metersToDegreesLon(marginM, midLat);
  const dLat = metersToDegreesLat(marginM);
  return [west - dLon, south - dLat, east + dLon, north + dLat];
}

function flattenCoords(geometry) {
  if (geometry.type === "Polygon") return geometry.coordinates.flat();
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
  return [];
}

function resolveInspectionBounds(map, { parcelId, treeId }) {
  if (treeId) {
    const feature = map.queryRenderedFeatures({ layers: ["tree-crowns-fill"] }).find((f) => f.properties.tree_id === treeId);
    if (feature) {
      const coords = flattenCoords(feature.geometry);
      if (coords.length) return { bounds: bboxFromCoords(coords, PARCEL_MARGIN_M), coords };
    }
  }
  if (parcelId) {
    const feature = map.queryRenderedFeatures({ layers: ["parcel-fill"] }).find((f) => f.properties.parcel_id === parcelId);
    if (feature) {
      const coords = flattenCoords(feature.geometry);
      if (coords.length) return { bounds: bboxFromCoords(coords, PARCEL_MARGIN_M), coords };
    }
  }
  // Fallback: a small bounded window around the current map center -- never
  // the full AOI/dataset.
  const c = map.getCenter();
  return { bounds: bboxFromCoords([[c.lng, c.lat]], 150), coords: null };
}

export async function openLidarInspection(map, { parcelId, treeId, treetopProps }) {
  showModal(parcelId, treeId, "loading");

  previousCameraState = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };

  const { bounds, coords } = resolveInspectionBounds(map, { parcelId, treeId });
  const [west, south, east, north] = bounds;
  const center = { lng: (west + east) / 2, lat: (south + north) / 2 };
  const framedView = { center, zoom: Math.max(map.getZoom(), treeId ? 18 : 15.5), pitch: 60, bearing: 20 };

  map.easeTo({ ...framedView, duration: 700 });

  try {
    const mod = await getLidarModule();
    const ctrl = getOrCreateControl(map, mod);

    if (currentCloudId) {
      try { ctrl.unloadPointCloud(currentCloudId); } catch (e) { /* already gone */ }
      currentCloudId = null;
    }

    await ctrl.loadPointCloudEptStreaming(EPT_SOURCE_URL, { bounds });
    // maplibre-gl-lidar auto-frames the camera to the SOURCE's full metadata
    // bounds on load (the whole USGS acquisition, not our bounded query) --
    // re-assert our own selected-tree/parcel framing immediately after, so
    // the library's internal auto-fly never wins the final camera state.
    map.jumpTo(framedView);
    await new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        const progress = ctrl.getStreamingProgress() || {};
        const clouds = ctrl.getPointClouds();
        if (clouds.length && currentCloudId === null) currentCloudId = clouds[clouds.length - 1].id;
        const settled = progress.isLoading === false && (progress.queueSize ?? 0) === 0;
        if (settled || Date.now() - start > 8000) resolve();
        else setTimeout(poll, 250);
      };
      setTimeout(poll, 250); // let internal streaming state register before the first check
    });

    map.jumpTo(framedView); // re-assert again after settling, in case the library re-fit mid-stream
    const progress = ctrl.getStreamingProgress() || {};
    showModal(parcelId, treeId, "loaded", { pointCount: progress.loadedPoints ?? 0 });
  } catch (err) {
    console.error("LiDAR streaming failed:", err);
    showModal(parcelId, treeId, "error", { message: err.message });
  }
}

function showModal(parcelId, treeId, status, extra = {}) {
  let modal = document.querySelector("#lidar-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "lidar-modal";
    modal.className = "lidar-modal";
    document.body.appendChild(modal);
  }
  const targetLabel = treeId ? "the selected tree" : `parcel ${parcelId}`;
  let statusHtml = "";
  if (status === "loading") {
    statusHtml = `Streaming real LiDAR points for ${targetLabel} from USGS 3DEP (bounded to this area only)&hellip;`;
  } else if (status === "loaded") {
    statusHtml = `${(extra.pointCount ?? 0).toLocaleString()} real LiDAR points loaded for ${targetLabel}.<br/>Height coloring (terrain colormap) applied. Classification/RGB not shown -- not available in this source at useful density.`;
  } else if (status === "error") {
    statusHtml = `Could not stream LiDAR points for ${targetLabel} (${extra.message ?? "unknown error"}). Camera framing is still shown above.`;
  }
  modal.innerHTML = `
    <div class="lidar-modal-body">
      <div class="lidar-modal-title">3D Inspection${treeId ? ` -- ${treeId}` : ""}</div>
      <div class="lidar-modal-note">${statusHtml}</div>
      <button id="lidar-modal-close" class="text-button" type="button">Close 3D view</button>
    </div>
  `;
  modal.hidden = false;
  document.querySelector("#lidar-modal-close").addEventListener("click", () => closeLidarInspection(modal));
}

function closeLidarInspection(modal) {
  modal.hidden = true;
  // Unload/stop the point-cloud overlay FIRST -- deck.gl's own render loop
  // can otherwise keep re-asserting the pitched camera view while it's
  // still active, fighting a camera reset issued while it's live.
  if (lidarControl && currentCloudId) {
    try { lidarControl.unloadPointCloud(currentCloudId); } catch (e) { /* already gone */ }
    try { lidarControl.stopStreaming(); } catch (e) { /* no-op if already stopped */ }
    currentCloudId = null;
  }
  const map = window.__timberRadarMap;
  if (map && previousCameraState) {
    map.jumpTo(previousCameraState);
  }
}
