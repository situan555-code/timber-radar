// Lazy-loaded 3D LiDAR inspection module -- imported only when the user
// clicks "Inspect LiDAR in 3D", so its (deck.gl-based) dependency cost is
// never paid on normal Timber Radar startup.
//
// Renderer: maplibre-gl-lidar (EPT streaming via deck.gl), loaded from
// esm.sh at first use. Source: the SAME public USGS 3DEP EPT acquisition
// (OH_Statewide_Phase2_6_2020) already used by the analysis pipeline.
//
// Alignment note (verified 2026-09-16, scripts/audit_3d_alignment.py): an
// independent bounded PDAL read at the canonical treetop position agreed
// with the CHM/DTM-derived height to within 0.00m. The LiDAR data itself
// is correctly georeferenced -- the "slab"/misalignment appearance this
// module previously had was a display/fusion problem (unhonored `bounds`
// streaming option, viewport-driven node selection, vertical
// auto-normalization against a flat basemap), not a data problem.

const LIDAR_MODULE_URL = "https://esm.sh/maplibre-gl-lidar@0.17.0";
const EPT_SOURCE_URL = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/OH_Statewide_Phase2_6_2020/ept.json";
const TREE_POINT_BUDGET_DESKTOP = 350_000;
const TREE_POINT_BUDGET_MOBILE = 120_000;
const PARCEL_POINT_BUDGET_DESKTOP = 2_000_000;
const PARCEL_POINT_BUDGET_MOBILE = 400_000;
const PARCEL_MARGIN_M = 20;
const TREE_CONTEXT_MARGIN_M = 30; // "crown + 20-40m context" per instruction
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
let currentMode = "canopy";
let lastGroundEstimateM = null;
let lastTopEstimateM = null;

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
    colorRange: { mode: "percentile", percentileLow: 5, percentileHigh: 95 },
    // See the top-of-file alignment note: autoZoom fits the camera to the
    // EPT source's FULL dataset bounds (not our query), and any camera
    // change after streaming starts resets the adaptive streaming
    // manager and stops new points loading. Disabling it and never
    // touching the camera again after load is what makes points load AND
    // land in the right place.
    autoZoom: false,
    // Now that real terrain is available (map.setTerrain), render points
    // at their true absolute elevation instead of the library's default
    // "shift minimum toward zero" normalization, so the cloud can visibly
    // sit on/grow out of the terrain-draped basemap rather than floating
    // at an arbitrary height above it.
    autoZOffset: false,
  });
  map.addControl(lidarControl, "top-right");
  // The library ships its own full generic panel (metadata, cross-section,
  // classification toggles, layer list, etc.) -- none of that belongs in
  // the Timber Radar product surface. Timber Radar exposes only the
  // corner status badge + the Canopy/Height/Classified mode strip.
  // getContainer() returns the small top-right control-corner element,
  // but the library's actual full panel (color/point-size/opacity/3D
  // terrain/metadata UI) renders as its own floating element elsewhere in
  // the DOM ("lidar-control-panel"), NOT nested inside that container --
  // hiding only the container left the real panel fully visible in
  // production. Hide both, and re-assert after the panel exists (its
  // first real DOM insertion can happen asynchronously after the control
  // is added).
  const hidePanel = () => {
    const container = lidarControl.getContainer?.();
    if (container) container.style.display = "none";
    const panel = lidarControl.getPanelElement?.();
    if (panel) panel.style.display = "none";
  };
  hidePanel();
  setTimeout(hidePanel, 300);
  setTimeout(hidePanel, 1000);
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

function bboxAround(lon, lat, marginM) {
  const dLon = metersToDegreesLon(marginM, lat);
  const dLat = metersToDegreesLat(marginM);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

function flattenCoords(geometry) {
  if (geometry.type === "Polygon") return geometry.coordinates.flat();
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
  return [];
}

function resolveInspectionAnchor(map, { parcelId, treeId, treetopProps }) {
  // The canonical treetop_lon/treetop_lat (added to the tile allowlist
  // specifically for this) is the authoritative 3D anchor -- NOT a
  // centroid derived from vector-tile crown geometry, which tippecanoe
  // can clip/simplify away from the true position.
  if (treeId && treetopProps?.treetop_lon != null && treetopProps?.treetop_lat != null) {
    return {
      lon: treetopProps.treetop_lon,
      lat: treetopProps.treetop_lat,
      bounds: bboxAround(treetopProps.treetop_lon, treetopProps.treetop_lat, TREE_CONTEXT_MARGIN_M),
    };
  }
  if (parcelId) {
    const feature = map.queryRenderedFeatures({ layers: ["parcel-fill"] }).find((f) => f.properties.parcel_id === parcelId);
    if (feature) {
      const coords = flattenCoords(feature.geometry);
      if (coords.length) {
        const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
        const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
        let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
        for (const [x, y] of coords) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
        const dLon = metersToDegreesLon(PARCEL_MARGIN_M, lat);
        const dLat = metersToDegreesLat(PARCEL_MARGIN_M);
        return { lon, lat, bounds: [west - dLon, south - dLat, east + dLon, north + dLat] };
      }
    }
  }
  const c = map.getCenter();
  return { lon: c.lng, lat: c.lat, bounds: bboxAround(c.lng, c.lat, 150) };
}

export async function openLidarInspection(map, { parcelId, treeId, treetopProps }) {
  showStatusBadge("loading", { treeId, parcelId });
  window.__timberRadarSetInspectMode?.(true);

  previousCameraState = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };

  suppressAnalyticalLayers(map);

  const { lon, lat, bounds } = resolveInspectionAnchor(map, { parcelId, treeId, treetopProps });
  const center = { lng: lon, lat };

  // Enabling terrain before the DEM tile for this location has actually
  // loaded makes MapLibre clamp any pitched camera we set right after --
  // it protects against the camera ending up underground once real
  // (~300m+) elevation data arrives, which visibly collapsed the intended
  // pitch/zoom in testing. Jump directly over the target first (flat), so
  // the terrain tile for the correct location loads, THEN enable terrain
  // and ease into the oblique view once MapLibre is idle.
  map.jumpTo({ center, zoom: Math.max(map.getZoom(), treeId ? 19.5 : 17), pitch: 0, bearing: 0 });
  window.__timberRadarSetTerrain?.(true);
  await new Promise((resolve) => {
    map.once("idle", resolve);
    setTimeout(resolve, 2000); // don't block indefinitely if idle never fires
  });
  // Oblique camera with real vertical relief. Pitch is deliberately more
  // moderate than a first attempt at "dramatic" (68deg) -- at very steep
  // pitch, the EPT loader's viewport-driven node selection (see the
  // top-of-file note; the library does not honor a spatial `bounds`
  // option, it infers needed octree nodes from the projected ground
  // footprint of the camera viewport) fetches a much larger ground
  // footprint toward the horizon, which is what produced the oversized
  // rectangular "slab" of points. A more moderate pitch keeps that
  // footprint closer to the actual inspection target while still reading
  // as clearly 3D/oblique.
  const framedView = treeId
    ? { center, zoom: Math.max(map.getZoom(), 19.5), pitch: 48, bearing: 30 }
    : { center, zoom: Math.max(map.getZoom(), 17), pitch: 42, bearing: 20 };

  map.easeTo({ ...framedView, duration: 700 });

  if (treeId && treetopProps?.height_max_ft != null) {
    window.__timberRadarSetTreeRuler?.(lon, lat, treetopProps.height_max_ft * 0.3048);
  } else {
    window.__timberRadarSetTreeRuler?.(null, null, null);
  }

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
    // the view set via map.easeTo(framedView) before streaming started is
    // left alone, which is what keeps the adaptive streaming manager (and
    // the actual rendered points) intact.
    const bounds2 = ctrl.getState().computedColorBounds;
    lastGroundEstimateM = bounds2?.min ?? null;
    lastTopEstimateM = bounds2?.max ?? null;
    applyRenderMode(currentMode);

    const progress = ctrl.getStreamingProgress() || {};
    showStatusBadge("loaded", { treeId, parcelId, pointCount: progress.loadedPoints ?? 0 });
    showModeStrip();
  } catch (err) {
    console.error("LiDAR streaming failed:", err);
    showStatusBadge("error", { treeId, parcelId, message: err.message });
  }
}

function applyRenderMode(mode) {
  currentMode = mode;
  if (!lidarControl) return;
  const ground = lastGroundEstimateM;
  const top = lastTopEstimateM;
  try {
    if (mode === "classified") {
      lidarControl.clearElevationRange?.();
      lidarControl.setColorScheme("classification");
      return;
    }
    lidarControl.setColorScheme("elevation");
    lidarControl.setColormap("terrain");
    if (ground != null && top != null && top > ground) {
      lidarControl.setUsePercentile(false);
      lidarControl.setColorRange({ mode: "absolute", absoluteMin: ground, absoluteMax: top });
      if (mode === "canopy") {
        // Height-above-ground is not literally computed per point here
        // (that needs per-point DTM subtraction, a larger follow-up), but
        // this suppresses the ground/near-ground return band using the
        // real loaded-cloud elevation bounds, so the visible points read
        // as vegetation/canopy rather than a solid ground plane.
        const groundBandM = Math.min(2.0, (top - ground) * 0.1);
        lidarControl.setElevationRange?.([ground + groundBandM, top + 1]);
      } else {
        lidarControl.clearElevationRange?.();
      }
    } else {
      lidarControl.setUsePercentile(true);
      lidarControl.clearElevationRange?.();
    }
  } catch (e) {
    console.warn("Render mode not fully applied:", e);
  }
}

function showModeStrip() {
  const strip = document.querySelector("#lidar-mode-strip");
  if (!strip) return;
  strip.hidden = false;
  strip.querySelectorAll(".lidar-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === currentMode);
    btn.onclick = () => {
      strip.querySelectorAll(".lidar-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      applyRenderMode(btn.dataset.mode);
    };
  });
}

function hideModeStrip() {
  const strip = document.querySelector("#lidar-mode-strip");
  if (strip) strip.hidden = true;
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
    line2 = "USGS 3DEP · Back to map ✕";
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
  hideModeStrip();
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
  window.__timberRadarSetTerrain?.(false);
  window.__timberRadarSetTreeRuler?.(null, null, null);
  window.__timberRadarSetInspectMode?.(false);
}
