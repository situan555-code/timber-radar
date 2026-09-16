// Lazy-loaded 3D LiDAR inspection module -- imported only when the user
// clicks "Inspect LiDAR in 3D", so its (deck.gl-based) dependency cost is
// never paid on normal Timber Radar startup.
//
// Renderer: maplibre-gl-lidar (EPT streaming via deck.gl), loaded from
// esm.sh at first use. Source: the SAME public USGS 3DEP EPT acquisition
// (OH_Statewide_Phase2_6_2020) already used by the analysis pipeline --
// verified working via bounded streaming reads. COPC fallback not needed
// (EPT passed on first attempt).

const LIDAR_MODULE_URL = "https://esm.sh/maplibre-gl-lidar@0.17.0";
const EPT_SOURCE_URL = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/OH_Statewide_Phase2_6_2020/ept.json";
const TREE_POINT_BUDGET_DESKTOP = 350_000;
const TREE_POINT_BUDGET_MOBILE = 120_000;
const PARCEL_POINT_BUDGET_DESKTOP = 2_000_000;
const PARCEL_POINT_BUDGET_MOBILE = 400_000;
const PARCEL_MARGIN_M = 20;
const MOBILE_WIDTH_BREAKPOINT = 700;

// Layers hidden while 3D inspection is active -- the point cloud is the
// whole point of this view; the CHM raster and the opportunity-score
// heatmap would otherwise visually compete with it directly.
const SUPPRESSED_LAYER_IDS = [
  "chm-raster", "parcel-fill", "parcel-outline", "parcel-outline-provisional",
  "roads-line", "tree-crowns-fill", "tree-crowns-outline", "tree-tops-circle",
];

let lidarModulePromise = null;
let lidarControl = null;
let previousCameraState = null;
let currentCloudId = null;
let suppressedLayerPriorVisibility = null;

function isMobileWidth() {
  return window.innerWidth < MOBILE_WIDTH_BREAKPOINT;
}

function pickPointBudget(isTreeLevel) {
  if (isTreeLevel) return isMobileWidth() ? TREE_POINT_BUDGET_MOBILE : TREE_POINT_BUDGET_DESKTOP;
  return isMobileWidth() ? PARCEL_POINT_BUDGET_MOBILE : PARCEL_POINT_BUDGET_DESKTOP;
}

async function getLidarModule() {
  if (!lidarModulePromise) lidarModulePromise = import(LIDAR_MODULE_URL);
  return lidarModulePromise;
}

function getOrCreateControl(map, mod, pointBudget) {
  if (lidarControl) {
    try { lidarControl.setPointBudget(pointBudget); } catch (e) { /* ignore */ }
    return lidarControl;
  }
  lidarControl = new mod.LidarControl({
    pointBudget,
    // Narrow percentile range + a restrained terrain palette so tall
    // canopy separates clearly from ground/low vegetation instead of
    // reading as one continuous colored carpet.
    colorRange: { mode: "percentile", percentileLow: 5, percentileHigh: 95 },
    // CRITICAL: the library's own autoZoom calls map.fitBounds() to the
    // EPT SOURCE's full dataset bounds (the whole USGS acquisition), not
    // our bounded query -- and any camera change after streaming starts
    // (including our own corrective jumpTo/easeTo) resets its adaptive
    // viewport-driven streaming manager, wiping out already-rendered
    // points. Disabling autoZoom and never touching the camera again
    // after the load call is what actually fixes both the wrong-location
    // framing bug AND makes the point cloud render at all.
    autoZoom: false,
  });
  map.addControl(lidarControl, "top-right");
  // The library ships its own full generic panel (metadata, cross-section,
  // classification toggles, layer list, etc.) -- none of that belongs in
  // the Timber Radar product surface, so it's hidden entirely; the small
  // status badge below is the only 3D UI the product exposes.
  const container = lidarControl.getContainer?.();
  if (container) container.style.display = "none";
  try {
    lidarControl.setColorScheme("elevation");
    lidarControl.setColormap("terrain");
    lidarControl.setPointSize?.(1.5);
  } catch (e) {
    console.warn("LiDAR color/point styling not applied:", e);
  }
  return lidarControl;
}

function suppressAnalyticalLayers(map) {
  if (suppressedLayerPriorVisibility) return; // already suppressed
  suppressedLayerPriorVisibility = {};
  for (const id of SUPPRESSED_LAYER_IDS) {
    if (!map.getLayer(id)) continue;
    suppressedLayerPriorVisibility[id] = map.getLayoutProperty(id, "visibility") ?? "visible";
    map.setLayoutProperty(id, "visibility", "none");
  }
}

function restoreAnalyticalLayers(map) {
  if (!suppressedLayerPriorVisibility) return;
  for (const [id, visibility] of Object.entries(suppressedLayerPriorVisibility)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
  }
  suppressedLayerPriorVisibility = null;
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
  showStatusBadge("loading", { treeId, parcelId });

  previousCameraState = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };

  suppressAnalyticalLayers(map);

  const { bounds } = resolveInspectionBounds(map, { parcelId, treeId });
  const [west, south, east, north] = bounds;
  const center = { lng: (west + east) / 2, lat: (south + north) / 2 };
  // Oblique, clearly-tilted camera with real vertical relief -- not a
  // near-flat "tilted heatmap" view. Zoomed in close enough for a single
  // tree's canopy structure to read as individual points, not a carpet.
  const framedView = treeId
    ? { center, zoom: Math.max(map.getZoom(), 19.2), pitch: 68, bearing: 35 }
    : { center, zoom: Math.max(map.getZoom(), 16.5), pitch: 62, bearing: 25 };

  map.easeTo({ ...framedView, duration: 700 });

  try {
    const mod = await getLidarModule();
    const pointBudget = pickPointBudget(!!treeId);
    const ctrl = getOrCreateControl(map, mod, pointBudget);

    if (currentCloudId) {
      try { ctrl.unloadPointCloud(currentCloudId); } catch (e) { /* already gone */ }
      currentCloudId = null;
    }

    await ctrl.loadPointCloudEptStreaming(EPT_SOURCE_URL, { bounds, pointBudget });
    await new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        const progress = ctrl.getStreamingProgress() || {};
        const clouds = ctrl.getPointClouds();
        if (clouds.length && currentCloudId === null) currentCloudId = clouds[clouds.length - 1].id;
        const settled = progress.isLoading === false && (progress.queueSize ?? 0) === 0;
        showStatusBadge("loading", { treeId, parcelId, pointCount: progress.loadedPoints ?? 0 });
        if (settled || Date.now() - start > 8000) resolve();
        else setTimeout(poll, 250);
      };
      setTimeout(poll, 250); // let internal streaming state register before the first check
    });

    // Deliberately no camera call here -- with autoZoom disabled above,
    // the view we set with map.easeTo(framedView) before streaming started
    // is left alone, which is what keeps the adaptive streaming manager
    // (and the actual rendered points) intact.
    const progress = ctrl.getStreamingProgress() || {};
    showStatusBadge("loaded", { treeId, parcelId, pointCount: progress.loadedPoints ?? 0 });
  } catch (err) {
    console.error("LiDAR streaming failed:", err);
    showStatusBadge("error", { treeId, parcelId, message: err.message });
  }
}

function showStatusBadge(status, { treeId, parcelId, pointCount, message } = {}) {
  let badge = document.querySelector("#lidar-status-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "lidar-status-badge";
    badge.className = "lidar-status-badge";
    document.body.appendChild(badge);
  }
  const targetLabel = treeId ? "selected tree" : `parcel ${parcelId}`;
  let line1 = "";
  let line2 = "";
  if (status === "loading") {
    line1 = "Loading LiDAR…";
    line2 = pointCount ? `${pointCount.toLocaleString()} points` : `USGS 3DEP · ${targetLabel}`;
  } else if (status === "loaded") {
    line1 = `${(pointCount ?? 0).toLocaleString()} points`;
    line2 = "Height coloring · USGS 3DEP";
  } else if (status === "error") {
    line1 = "LiDAR unavailable";
    line2 = message ?? "Camera framing shown above";
  }
  badge.innerHTML = `
    <div class="lidar-badge-text"><span class="lidar-badge-line1">${line1}</span><span class="lidar-badge-line2">${line2}</span></div>
    <button id="lidar-badge-close" class="icon-button" type="button" aria-label="Back to map">✕</button>
  `;
  badge.hidden = false;
  document.querySelector("#lidar-badge-close").addEventListener("click", closeLidarInspection);
}

function closeLidarInspection() {
  const badge = document.querySelector("#lidar-status-badge");
  if (badge) badge.hidden = true;
  // Unload/stop the point-cloud overlay FIRST -- deck.gl's own render loop
  // can otherwise keep re-asserting the pitched camera view while it's
  // still active, fighting a camera reset issued while it's live.
  if (lidarControl && currentCloudId) {
    try { lidarControl.unloadPointCloud(currentCloudId); } catch (e) { /* already gone */ }
    try { lidarControl.stopStreaming(); } catch (e) { /* no-op if already stopped */ }
    currentCloudId = null;
  }
  const map = window.__timberRadarMap;
  if (map) {
    restoreAnalyticalLayers(map);
    if (previousCameraState) map.jumpTo(previousCameraState);
  }
}
