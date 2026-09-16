// Lazy-loaded 3D LiDAR inspection module -- imported only when the user
// clicks "Inspect LiDAR in 3D", so its (deck.gl-based) dependency cost is
// never paid on normal Timber Radar startup.
//
// Renderer: maplibre-gl-lidar (EPT streaming via deck.gl), loaded from
// esm.sh at first use. Source: the SAME public USGS 3DEP EPT acquisition
// (OH_Statewide_Phase2_6_2020) already used by the analysis pipeline.
//
// Alignment note (verified 2026-09-16, scripts/audit_3d_alignment.py +
// scripts/audit_3d_alignment_xy.py): independent bounded PDAL reads at
// three canonical treetops agree with CHM/DTM-derived height/position
// closely. The LiDAR data itself is correctly georeferenced.
//
// Real EPT clipping (2026-09-16 round 2): the library's
// loadPointCloudEptStreaming does NOT support a spatial `bounds` option
// -- it silently ignores it and selects octree nodes from the camera
// viewport's projected ground footprint instead. That produced a large
// hard-edged rectangular point mass unrelated to the selected tree (the
// "slab" bug). Fixed by wrapping the internal point-cloud manager's
// update methods to spatially clip every incoming batch to the actual
// inspection bbox before it ever reaches the renderer -- extra octree
// nodes may still be fetched over the network, but nothing outside the
// inspection region is ever added to the drawable point set.

const LIDAR_MODULE_URL = "https://esm.sh/maplibre-gl-lidar@0.17.0";
const EPT_SOURCE_URL = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/OH_Statewide_Phase2_6_2020/ept.json";
const TREE_POINT_BUDGET_DESKTOP = 350_000;
const TREE_POINT_BUDGET_MOBILE = 120_000;
const PARCEL_POINT_BUDGET_DESKTOP = 2_000_000;
const PARCEL_POINT_BUDGET_MOBILE = 400_000;
const PARCEL_MARGIN_M = 20;
const TREE_CONTEXT_MARGIN_M = 30; // "crown + 20-40m context" per instruction
const MOBILE_WIDTH_BREAKPOINT = 700;

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
let currentInspectionBounds = null;
let currentInspectionCenter = null;
let lastTarget = null;

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

// --- Real spatial clipping (item 2) -----------------------------------
// Wraps _pointCloudManager.updatePointCloud/addPointCloud so every point
// batch is filtered, BEFORE it reaches the renderer, to points whose
// absolute lon/lat fall inside the current inspection bbox. Positions are
// stored as [dLon, dLat, z] offsets from a `coordinateOrigin` (verified
// empirically -- the origin is the EPT source's own dataset-center
// metadata, unrelated to our query), so absolute = origin + offset.
function clipPointCloudData(data, bounds) {
  if (!bounds || !data?.positions || !data.coordinateOrigin) return data;
  const [west, south, east, north] = bounds;
  const [ox, oy] = data.coordinateOrigin;
  const n = data.pointCount ?? data.positions.length / 3;
  const keep = [];
  for (let i = 0; i < n; i++) {
    const lon = ox + data.positions[i * 3];
    const lat = oy + data.positions[i * 3 + 1];
    if (lon >= west && lon <= east && lat >= south && lat <= north) keep.push(i);
  }
  const m = keep.length;
  const outPositions = new Float32Array(m * 3);
  const outColors = data.colors ? new data.colors.constructor((m * data.colors.length) / n) : undefined;
  const outIntensities = data.intensities ? new data.intensities.constructor(m) : undefined;
  const outClassifications = data.classifications ? new data.classifications.constructor(m) : undefined;
  const colorStride = data.colors ? data.colors.length / n : 0;
  for (let d = 0; d < m; d++) {
    const s = keep[d];
    outPositions[d * 3] = data.positions[s * 3];
    outPositions[d * 3 + 1] = data.positions[s * 3 + 1];
    outPositions[d * 3 + 2] = data.positions[s * 3 + 2];
    if (outColors) for (let k = 0; k < colorStride; k++) outColors[d * colorStride + k] = data.colors[s * colorStride + k];
    if (outIntensities) outIntensities[d] = data.intensities[s];
    if (outClassifications) outClassifications[d] = data.classifications[s];
  }
  return {
    ...data,
    positions: outPositions,
    colors: outColors,
    intensities: outIntensities,
    classifications: outClassifications,
    // extraAttributes dropped -- its per-point stride isn't verified here,
    // and it isn't used by any current render mode, so it's safer to omit
    // than to risk a length-mismatch downstream.
    extraAttributes: undefined,
    pointCount: m,
  };
}

function installSpatialClip(ctrl) {
  const pcm = ctrl._pointCloudManager;
  if (!pcm || pcm.__trClipInstalled) return;
  for (const methodName of ["updatePointCloud", "addPointCloud"]) {
    const orig = pcm[methodName]?.bind(pcm);
    if (!orig) continue;
    pcm[methodName] = (id, data) => orig(id, clipPointCloudData(data, currentInspectionBounds));
  }
  pcm.__trClipInstalled = true;
}

function getOrCreateControl(map, mod, pointBudget) {
  if (lidarControl) {
    try { lidarControl.setPointBudget(pointBudget); } catch (e) { /* ignore */ }
    installSpatialClip(lidarControl);
    return lidarControl;
  }
  lidarControl = new mod.LidarControl({
    pointBudget,
    colorRange: { mode: "percentile", percentileLow: 5, percentileHigh: 95 },
    autoZoom: false,
    autoZOffset: false,
  });
  map.addControl(lidarControl, "top-right");
  installSpatialClip(lidarControl);
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
  if (suppressedLayerPriorVisibility) return;
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

function logDebugTelemetry(stage, extra) {
  const info = {
    stage,
    canonical_lon_lat: currentInspectionCenter,
    inspection_bbox: currentInspectionBounds,
    ...extra,
  };
  window.LIDAR_INSPECTION_DEBUG = { ...(window.LIDAR_INSPECTION_DEBUG || {}), [stage]: info };
  console.log("[LIDAR_INSPECTION_DEBUG]", stage, info);
}

export async function openLidarInspection(map, target) {
  const { parcelId, treeId, treetopProps, geometry } = target;
  lastTarget = target;
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
  currentInspectionBounds = bounds;
  currentInspectionCenter = [lon, lat];
  const center = { lng: lon, lat };
  window.__timberRadarSetDebugBbox?.(bounds);

  map.jumpTo({ center, zoom: Math.max(map.getZoom(), treeId ? 19.5 : 17), pitch: 0, bearing: 0 });
  window.__timberRadarSetTerrain?.(true);
  await new Promise((resolve) => {
    map.once("idle", resolve);
    setTimeout(resolve, 2000);
  });

  const framedView = treeId
    ? { center, zoom: Math.max(map.getZoom(), 19.5), pitch: 48, bearing: 30 }
    : { center, zoom: Math.max(map.getZoom(), 17), pitch: 42, bearing: 20 };
  map.easeTo({ ...framedView, duration: 700 });

  if (treeId && treetopProps?.height_max_ft != null) {
    const heightM = treetopProps.height_max_ft * 0.3048;
    window.__timberRadarSetTreeRuler?.(lon, lat, heightM);
    if (geometry) window.__timberRadarSetElevatedCrown?.(geometry, heightM);
  } else {
    window.__timberRadarSetTreeRuler?.(null, null, null);
    window.__timberRadarSetElevatedCrown?.(null, null);
  }

  logDebugTelemetry("anchor_resolved", { camera_center: center, camera_target_zoom_pitch_bearing: framedView });

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
      setTimeout(poll, 250);
    });

    // ctrl.getState().computedColorBounds reflects the EPT SOURCE's full
    // dataset elevation range (verified empirically: 211-538m, matching
    // the whole Ohio acquisition, not this local scene), not the actual
    // clipped points -- deriving our own ground/top estimate directly
    // from the real (post-clip) loaded point Z values instead.
    const progress = ctrl.getStreamingProgress() || {};
    const merged = ctrl._pointCloudManager?.getMergedPointCloudData?.();
    let insideCount = null;
    if (merged?.positions && merged.pointCount > 0) {
      insideCount = merged.pointCount;
      let zMin = Infinity, zMax = -Infinity;
      for (let i = 0; i < merged.pointCount; i++) {
        const z = merged.positions[i * 3 + 2];
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }
      lastGroundEstimateM = zMin;
      lastTopEstimateM = zMax;
    } else {
      lastGroundEstimateM = null;
      lastTopEstimateM = null;
    }
    applyRenderMode(currentMode);
    logDebugTelemetry("loaded", {
      total_loaded_points: progress.loadedPoints ?? 0,
      points_after_spatial_clip: insideCount,
      percent_inside_bbox: insideCount != null && progress.loadedPoints ? Math.round((insideCount / progress.loadedPoints) * 1000) / 10 : null,
      ground_estimate_m: lastGroundEstimateM,
      top_estimate_m: lastTopEstimateM,
    });

    showStatusBadge("loaded", { treeId, parcelId, pointCount: merged?.pointCount ?? progress.loadedPoints ?? 0 });
    showModeStrip();
  } catch (err) {
    console.error("LiDAR streaming failed:", err);
    showStatusBadge("error", { treeId, parcelId, message: err.message });
  }
}

export async function recenterOnTree() {
  if (!lastTarget) return;
  const map = window.__timberRadarMap;
  if (!map) return;
  await openLidarInspection(map, lastTarget);
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
        // Real ASPRS classification codes for this source are almost
        // entirely "Unclassified"/"Ground" (verified empirically -- no
        // vegetation classes present), so canopy/ground separation here
        // is an elevation-band approximation, not a classification-based
        // filter. This is disclosed in the UI copy, not claimed as HAG.
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
    line1 = `${(pointCount ?? 0).toLocaleString()} points in view`;
    line2 = "USGS 3DEP, clipped to selection";
  } else if (status === "error") {
    line1 = "LiDAR unavailable";
    line2 = message ?? "Camera framing shown above";
  }
  badge.innerHTML = `<div class="lidar-badge-text"><span class="lidar-badge-line1">${line1}</span><span class="lidar-badge-line2">${line2}</span></div>`;
  badge.hidden = false;
}

export function closeLidarInspection() {
  const badge = document.querySelector("#lidar-status-badge");
  if (badge) badge.hidden = true;
  hideModeStrip();
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
  window.__timberRadarSetElevatedCrown?.(null, null);
  window.__timberRadarSetDebugBbox?.(null);
  window.__timberRadarSetInspectMode?.(false);
  currentInspectionBounds = null;
  currentInspectionCenter = null;
}
