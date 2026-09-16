// Timber Radar — product map. Ranked, filterable browse -> inspect ->
// shortlist workflow over the 5792-parcel enriched dataset, delivered as
// static files (PMTiles vector tiles + a lightweight attribute index).

const AOI_BBOX = [-81.80, 40.40, -81.65, 40.55]; // [west, south, east, north], matches config/pilot.yaml
const PARCELS_PMTILES_URL = "./public/data/timber_parcels.pmtiles";
const CHM_PMTILES_URL = "./public/data/chm.pmtiles";
const ROADS_URL = "./public/data/roads_aoi.geojson";
const INDEX_URL = "./public/data/parcels_index.json";
const TREE_CROWNS_PMTILES_URL = "./public/data/tree_crowns.pmtiles";
const TREE_TOPS_PMTILES_URL = "./public/data/tree_tops.pmtiles";

// Progressive tree zoom thresholds -- must match config/tree_visualization.yaml's
// browser.* values (treetops_minzoom, crowns_minzoom, crowns_interactive_minzoom).
const TREETOPS_MINZOOM = 15;
const TREETOPS_FADE_ZOOM = 15.5;
const CROWNS_MINZOOM = 17;
const CROWNS_INTERACTIVE_MINZOOM = 17;

const SCORE_COLOR_STOPS = [
  0, "#4b5563",   // low
  40, "#eab308",  // medium
  70, "#65a30d",  // high
  92, "#166534",  // top opportunity
];

const COMPONENT_LABELS = {
  sc_mature_canopy: "Mature Canopy",
  sc_tall_acreage: "Tall Acreage",
  sc_stand_continuity: "Stand Continuity",
  sc_slope_access: "Slope / Terrain",
  sc_road_proximity: "Road Proximity",
  sc_harvest_recency: "Harvest Recency",
};
const COMPONENT_ORDER = ["sc_mature_canopy", "sc_tall_acreage", "sc_stand_continuity", "sc_slope_access", "sc_road_proximity", "sc_harvest_recency"];

// --- PMTiles protocol: register once at app startup. ---
const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);

let chmTilesAvailable = true;
try {
  const chmPm = new pmtiles.PMTiles(CHM_PMTILES_URL);
  pmtilesProtocol.add(chmPm);
  await chmPm.getHeader();
} catch (e) {
  chmTilesAvailable = false;
  console.warn("CHM tiles not available yet:", e);
}

// Tree crown/treetop tiles are loaded the same optional-availability way as
// CHM -- normal app startup must not depend on them existing, and (per the
// 2D performance budget) registering the PMTiles source here does NOT fetch
// tile bytes; those only start once MapLibre requests a tile inside the
// layers' own minzoom range, i.e. never on initial low-zoom load.
let treeTilesAvailable = true;
try {
  const crownsPm = new pmtiles.PMTiles(TREE_CROWNS_PMTILES_URL);
  const topsPm = new pmtiles.PMTiles(TREE_TOPS_PMTILES_URL);
  pmtilesProtocol.add(crownsPm);
  pmtilesProtocol.add(topsPm);
  await Promise.all([crownsPm.getHeader(), topsPm.getHeader()]);
} catch (e) {
  treeTilesAvailable = false;
  console.warn("Tree crown/treetop tiles not available yet:", e);
}

// High-zoom imagery: Esri World Imagery is a free, no-account, no-API-key
// public tile service (used broadly by open-source map projects for this
// exact purpose). Detected crowns are the intended hero at high zoom, and
// real aerial context reads far better under them than flat cartography.
const IMAGERY_MINZOOM = 15;

const map = new maplibregl.Map({
  container: "map",
  center: [(AOI_BBOX[0] + AOI_BBOX[2]) / 2, (AOI_BBOX[1] + AOI_BBOX[3]) / 2],
  zoom: 11,
  maxPitch: 75, // default 60 is too shallow for the 3D LiDAR inspection view's intended oblique relief
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
      satellite: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Esri, Maxar, Earthstar Geographics",
        maxzoom: 19,
      },
    },
    layers: [
      { id: "osm", type: "raster", source: "osm" },
      { id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
    ],
  },
});
map.fitBounds(AOI_BBOX, { padding: 24, duration: 0 });
window.__timberRadarMap = map; // small escape hatch for the lazy-loaded lidar module
map.addControl(new maplibregl.NavigationControl(), "top-left");

// --- App state ---
let parcelIndex = [];       // full attribute list (no geometry)
let indexById = new Map();
let selectedId = null;
let shortlist = new Set(loadShortlist());

const filters = {
  minScore: 0,
  minAcres: 0,
  minWooded: 0,
  minCanopyP90: 0,
  maxRoadDistance: null,
  minContinuityPct: 0,
  fullCoverageOnly: false,
  excludeFallback: false,
};

function loadShortlist() {
  try {
    return JSON.parse(localStorage.getItem("timberRadarShortlist") || "[]");
  } catch {
    return [];
  }
}
function saveShortlist() {
  localStorage.setItem("timberRadarShortlist", JSON.stringify([...shortlist]));
  document.querySelector("#shortlist-count").textContent = shortlist.size;
}

function scoreColorExpression() {
  const expr = ["interpolate", ["linear"], ["coalesce", ["get", "timber_score"], 0]];
  for (let i = 0; i < SCORE_COLOR_STOPS.length; i += 2) expr.push(SCORE_COLOR_STOPS[i], SCORE_COLOR_STOPS[i + 1]);
  return expr;
}

function fmt(value, suffix = "", digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}${suffix}` : "—";
}
function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";
}

function passesFilters(row) {
  if ((row.timber_score ?? 0) < filters.minScore) return false;
  if ((row.parcel_acres ?? 0) < filters.minAcres) return false;
  if ((row.wooded_acres ?? 0) < filters.minWooded) return false;
  if ((row.canopy_p90_ft ?? 0) < filters.minCanopyP90) return false;
  if (filters.maxRoadDistance != null && (row.road_distance_ft ?? Infinity) > filters.maxRoadDistance) return false;
  const continuityPct = (row.largest_patch_share ?? 0) * 100;
  if (continuityPct < filters.minContinuityPct) return false;
  if (filters.fullCoverageOnly && (row.feature_coverage ?? 0) < 0.95) return false;
  if (filters.excludeFallback && row.road_distance_fallback) return false;
  return true;
}

function mapLibreFilterExpression() {
  const clauses = ["all"];
  clauses.push([">=", ["coalesce", ["get", "timber_score"], 0], filters.minScore]);
  clauses.push([">=", ["coalesce", ["get", "parcel_acres"], 0], filters.minAcres]);
  clauses.push([">=", ["coalesce", ["get", "wooded_acres"], 0], filters.minWooded]);
  clauses.push([">=", ["coalesce", ["get", "canopy_p90_ft"], 0], filters.minCanopyP90]);
  if (filters.maxRoadDistance != null) {
    clauses.push(["<=", ["coalesce", ["get", "road_distance_ft"], 999999], filters.maxRoadDistance]);
  }
  clauses.push([">=", ["*", ["coalesce", ["get", "largest_patch_share"], 0], 100], filters.minContinuityPct]);
  if (filters.fullCoverageOnly) clauses.push([">=", ["coalesce", ["get", "feature_coverage"], 0], 0.95]);
  if (filters.excludeFallback) clauses.push(["!=", ["get", "road_distance_fallback"], true]);
  return clauses;
}

function applyFilters() {
  const expr = mapLibreFilterExpression();
  if (map.getLayer("parcel-fill")) map.setFilter("parcel-fill", expr);
  if (map.getLayer("parcel-outline")) map.setFilter("parcel-outline", [...expr, ["!=", ["get", "provisional"], true]]);
  if (map.getLayer("parcel-outline-provisional")) map.setFilter("parcel-outline-provisional", [...expr, ["==", ["get", "provisional"], true]]);
  renderList();
}

function renderList() {
  const rows = parcelIndex.filter(passesFilters).sort((a, b) => (b.timber_score ?? 0) - (a.timber_score ?? 0));
  document.querySelector("#result-count").textContent = `${rows.length} parcel${rows.length === 1 ? "" : "s"}`;
  const container = document.querySelector("#ranked-list");
  container.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    frag.appendChild(buildResultRow(row));
  }
  container.appendChild(frag);
}

function scoreColorForValue(score) {
  // Mirrors SCORE_COLOR_STOPS for plain-JS (list row) rendering.
  const stops = SCORE_COLOR_STOPS;
  if (score <= stops[0]) return stops[1];
  for (let i = 0; i + 3 < stops.length; i += 2) {
    if (score <= stops[i + 2]) {
      const t = (score - stops[i]) / (stops[i + 2] - stops[i]);
      return lerpColor(stops[i + 1], stops[i + 3], t);
    }
  }
  return stops[stops.length - 1];
}
function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bch = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bch})`;
}
function hexToRgb(hex) {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function buildResultRow(row) {
  const el = document.createElement("div");
  el.className = "result-row" + (row.parcel_id === selectedId ? " selected" : "");
  el.dataset.parcelId = row.parcel_id;
  const statusClass = (row.feature_coverage ?? 0) >= 0.95 ? "full" : "provisional";
  const statusLabel = (row.feature_coverage ?? 0) >= 0.95 ? "Full coverage" : "Provisional";
  el.innerHTML = `
    <div class="result-score" style="background:${scoreColorForValue(row.timber_score ?? 0)}">${row.timber_score ?? "—"}</div>
    <div class="result-meta">
      <span class="pid">${row.parcel_id}</span>
      <div class="metrics">
        <span>${fmt(row.parcel_acres, " ac")} parcel</span>
        <span>${fmt(row.wooded_acres, " ac")} wooded</span>
        <span>canopy p90 ${fmt(row.canopy_p90_ft, " ft")}</span>
        <span>road ${row.road_distance_ft != null ? fmt(row.road_distance_ft, " ft", 0) : "—"}</span>
        <span>continuity ${pct(row.largest_patch_share)}</span>
        <span class="status-chip ${statusClass}">${statusLabel}</span>
      </div>
    </div>
  `;
  el.addEventListener("click", () => selectParcel(row.parcel_id, { fly: true }));
  return el;
}

function selectParcel(parcelId, { fly = false } = {}) {
  selectedId = parcelId;
  const row = indexById.get(parcelId);
  if (!row) return;

  document.querySelectorAll(".result-row").forEach((el) => {
    el.classList.toggle("selected", el.dataset.parcelId === parcelId);
  });
  const selectedEl = document.querySelector(`.result-row[data-parcel-id="${parcelId}"]`);
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });

  if (map.getLayer("parcel-selected-outline")) {
    map.setFilter("parcel-selected-outline", ["==", ["get", "parcel_id"], parcelId]);
  }
  if (fly) {
    map.flyTo({ center: [row.centroid_lon, row.centroid_lat], zoom: Math.max(map.getZoom(), 14), duration: 600 });
  }
  openDetailPanel(row);
}

function componentBar(key, value) {
  const label = COMPONENT_LABELS[key];
  if (value == null) {
    return `<div class="component-bar-row">
      <div class="component-bar-label"><span>${label}</span><span class="not-included">Not yet included</span></div>
      <div class="component-bar-track"></div>
    </div>`;
  }
  return `<div class="component-bar-row">
    <div class="component-bar-label"><span>${label}</span><span>${fmt(value, "", 0)}</span></div>
    <div class="component-bar-track"><div class="component-bar-fill" style="width:${Math.max(0, Math.min(100, value))}%"></div></div>
  </div>`;
}

function openDetailPanel(row) {
  const panel = document.querySelector("#detail-panel");
  const body = document.querySelector("#detail-body");
  const inShortlist = shortlist.has(row.parcel_id);

  body.innerHTML = `
    <div class="detail-title">${row.parcel_id}</div>
    <div class="detail-sub">Score version ${row.score_version ?? "—"} · ${fmt((row.feature_coverage ?? 0) * 100, "%", 0)} feature coverage</div>

    <div class="score-hero">
      <div class="num" style="color:${scoreColorForValue(row.timber_score ?? 0)}">${row.timber_score ?? "—"}</div>
      <div class="label">Overall Timber Score<br/>out of 100</div>
    </div>

    ${COMPONENT_ORDER.map((k) => componentBar(k, row[k])).join("")}

    ${(row.feature_coverage ?? 0) < 0.95 ? `<div class="coverage-note">Provisional: this score currently uses ${fmt((row.feature_coverage ?? 0) * 100, "%", 0)} of planned timber factors. A full-coverage score does not yet include harvest recency.</div>` : ""}
    ${row.road_distance_fallback ? `<div class="fallback-note">Road distance measured from the parcel boundary (no wooded area detected on this parcel), not from a forest stand.</div>` : ""}

    <dl class="detail-metrics">
      <div><dt>Parcel acres</dt><dd>${fmt(row.parcel_acres, " ac")}</dd></div>
      <div><dt>Wooded acres</dt><dd>${fmt(row.wooded_acres, " ac")}</dd></div>
      <div><dt>Canopy p50</dt><dd>${fmt(row.canopy_p50_ft, " ft")}</dd></div>
      <div><dt>Canopy p90</dt><dd>${fmt(row.canopy_p90_ft, " ft")}</dd></div>
      <div><dt>80ft+ canopy share</dt><dd>${fmt(row.pct_canopy_over_80ft, "%")}</dd></div>
      <div><dt>Largest contiguous stand</dt><dd>${fmt(row.largest_forest_patch_acres, " ac")}</dd></div>
      <div><dt>Continuity</dt><dd>${pct(row.largest_patch_share)}</dd></div>
      <div><dt>Road distance</dt><dd>${row.road_distance_ft != null ? fmt(row.road_distance_ft, " ft", 0) : "—"}</dd></div>
      <div><dt>Mean slope</dt><dd>${fmt(row.mean_slope_pct, "%")}</dd></div>
      <div><dt>Harvest recency</dt><dd>Not yet included</dd></div>
    </dl>

    <div class="detail-actions">
      <button id="detail-shortlist-toggle" class="text-button" type="button">${inShortlist ? "Remove from shortlist" : "Add to shortlist"}</button>
    </div>
  `;
  panel.hidden = false;
  document.querySelector("#detail-shortlist-toggle").addEventListener("click", () => {
    toggleShortlist(row.parcel_id);
    openDetailPanel(row);
  });
}

// --- Tree crown selection/hover/detail (progressive disclosure below parcel level) ---
let selectedTreeId = null;

function showTreeHoverTooltip(e, props) {
  let tip = document.querySelector("#tree-hover-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "tree-hover-tip";
    tip.className = "tree-hover-tip";
    document.body.appendChild(tip);
  }
  const heightFt = Number(props.height_max_ft);
  const areaFt = Number(props.crown_area_sqft);
  tip.innerHTML = Number.isFinite(heightFt) ? `${heightFt.toFixed(0)} ft` : "—";
  if (Number.isFinite(areaFt)) tip.innerHTML += `<br/><span class="muted">${areaFt.toFixed(0)} ft² crown</span>`;
  tip.style.left = `${e.point.x + 12}px`;
  tip.style.top = `${e.point.y + 12}px`;
  tip.hidden = false;
}
function hideTreeHoverTooltip() {
  const tip = document.querySelector("#tree-hover-tip");
  if (tip) tip.hidden = true;
}

function selectTree(props) {
  selectedTreeId = props.tree_id;
  if (map.getLayer("tree-crown-selected-outline")) {
    map.setFilter("tree-crown-selected-outline", ["==", ["get", "tree_id"], props.tree_id]);
  }
  openTreeDetailPanel(props);
}

function openTreeDetailPanel(props) {
  const panel = document.querySelector("#tree-detail-panel");
  const body = document.querySelector("#tree-detail-body");
  const parcelId = props.treetop_parcel_id;
  const parcelRow = parcelId ? indexById.get(parcelId) : null;
  const flags = (props.quality_flags_flat || "").split(",").filter(Boolean);

  body.innerHTML = `
    <div class="detail-title">DETECTED CROWN</div>
    <div class="detail-sub">${props.tree_id}</div>

    <dl class="detail-metrics">
      <div><dt>Estimated height</dt><dd>${fmt(props.height_max_ft, " ft", 0)}</dd></div>
      <div><dt>Height p90</dt><dd>${fmt(props.height_p90_ft, " ft", 0)}</dd></div>
      <div><dt>Crown area</dt><dd>${fmt(props.crown_area_sqft, " ft²", 0)}</dd></div>
      <div><dt>Equivalent crown diameter</dt><dd>${fmt(props.crown_equivalent_diameter_ft, " ft", 0)}</dd></div>
      <div><dt>Parcel</dt><dd>${parcelId ?? "—"}</dd></div>
      <div><dt>Detection</dt><dd>LiDAR CHM</dd></div>
      <div><dt>Version</dt><dd>${props.segmentation_version ?? "—"}</dd></div>
      <div><dt>Quality flags</dt><dd>${flags.length ? flags.join(", ") : "None"}</dd></div>
    </dl>

    <div class="coverage-note">
      Species: Not estimated<br/>
      DBH: Not estimated<br/>
      Timber volume: Not estimated
    </div>

    <div class="detail-actions">
      ${parcelRow ? `<button id="tree-back-to-parcel" class="text-button" type="button">Back to parcel ${parcelId}</button>` : ""}
      <button id="tree-inspect-lidar" class="pill-button" type="button">Inspect LiDAR in 3D</button>
    </div>
  `;
  panel.hidden = false;

  if (parcelRow) {
    document.querySelector("#tree-back-to-parcel").addEventListener("click", () => {
      closeTreeDetailPanel();
      selectParcel(parcelId, { fly: false });
    });
  }
  document.querySelector("#tree-inspect-lidar").addEventListener("click", () => {
    openLidarInspection({ parcelId, treeId: props.tree_id, treetopProps: props });
  });
}

function closeTreeDetailPanel() {
  document.querySelector("#tree-detail-panel").hidden = true;
  selectedTreeId = null;
  if (map.getLayer("tree-crown-selected-outline")) {
    map.setFilter("tree-crown-selected-outline", ["==", ["get", "tree_id"], "__none__"]);
  }
}

async function openLidarInspection(target) {
  // Lazy-loaded so the 3D dependency cost is never paid on normal startup.
  const mod = await import("./lidar/lidarInspection.js");
  mod.openLidarInspection(map, target);
}

function toggleShortlist(parcelId) {
  if (shortlist.has(parcelId)) shortlist.delete(parcelId);
  else shortlist.add(parcelId);
  saveShortlist();
  renderShortlistDrawer();
}

function renderShortlistDrawer() {
  const body = document.querySelector("#shortlist-body");
  if (shortlist.size === 0) {
    body.innerHTML = `<div class="empty-note">No parcels shortlisted yet. Open a parcel's detail panel and add it.</div>`;
    return;
  }
  body.innerHTML = "";
  for (const pid of shortlist) {
    const row = indexById.get(pid);
    if (!row) continue;
    const el = document.createElement("div");
    el.className = "shortlist-row";
    el.innerHTML = `<span>${pid} · score ${row.timber_score ?? "—"}</span><button type="button">Remove</button>`;
    el.querySelector("button").addEventListener("click", () => {
      toggleShortlist(pid);
    });
    el.querySelector("span").addEventListener("click", () => selectParcel(pid, { fly: true }));
    body.appendChild(el);
  }
}

function exportShortlistCSV() {
  const rows = [...shortlist].map((id) => indexById.get(id)).filter(Boolean);
  const fields = ["parcel_id", "timber_score", "feature_coverage", "provisional", "parcel_acres", "wooded_acres",
    "canopy_p50_ft", "canopy_p90_ft", "pct_canopy_over_80ft", "mean_slope_pct", "largest_forest_patch_acres",
    "largest_patch_share", "road_distance_ft", "road_distance_fallback", "score_version"];
  const lines = [fields.join(",")];
  for (const r of rows) lines.push(fields.map((f) => JSON.stringify(r[f] ?? "")).join(","));
  downloadText("timber_shortlist.csv", lines.join("\n"), "text/csv");
}

function exportShortlistGeoJSON() {
  // Client-side export uses each parcel's centroid point (public score
  // metrics only) -- full polygon geometry lives in the PMTiles vector
  // tiles, not in the lightweight attribute index this static app loads,
  // so a full-boundary export isn't available without a server component.
  const rows = [...shortlist].map((id) => indexById.get(id)).filter(Boolean);
  const geojson = {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.centroid_lon, r.centroid_lat] },
      properties: { ...r },
    })),
  };
  downloadText("timber_shortlist.geojson", JSON.stringify(geojson, null, 2), "application/geo+json");
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Map setup ---
map.on("load", () => {
  map.addSource("parcels", { type: "vector", url: `pmtiles://${new URL(PARCELS_PMTILES_URL, location.href)}` });

  map.addLayer({
    id: "parcel-fill",
    type: "fill",
    source: "parcels",
    "source-layer": "timber_parcels",
    paint: {
      "fill-color": scoreColorExpression(),
      // The opportunity-score heatmap is the right identity at regional/
      // ranking zoom, but at high zoom detected crowns (+ real aerial
      // imagery) become the hero -- fade the score fill down instead of
      // letting it visually compete with individual crowns.
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.62, 15, 0.55, 17, 0.12],
    },
  });
  // line-dasharray does not support data-driven (per-feature) expressions
  // in MapLibre, so "solid outline = full coverage, dashed = provisional"
  // is implemented as two separate layers filtered by `provisional`,
  // rather than an unsupported data expression on one layer.
  map.addLayer({
    id: "parcel-outline",
    type: "line",
    source: "parcels",
    "source-layer": "timber_parcels",
    minzoom: 11,
    filter: ["!=", ["get", "provisional"], true],
    paint: { "line-color": "#0b0d0c", "line-width": 0.8 },
  });
  map.addLayer({
    id: "parcel-outline-provisional",
    type: "line",
    source: "parcels",
    "source-layer": "timber_parcels",
    minzoom: 11,
    filter: ["==", ["get", "provisional"], true],
    paint: { "line-color": "#0b0d0c", "line-width": 0.8, "line-dasharray": [2, 1.5] },
  });
  map.addLayer({
    id: "parcel-selected-outline",
    type: "line",
    source: "parcels",
    "source-layer": "timber_parcels",
    filter: ["==", ["get", "parcel_id"], "__none__"],
    paint: { "line-color": "#f8fafc", "line-width": 3.5 },
  });

  map.addSource("roads", { type: "geojson", data: ROADS_URL });
  map.addLayer({
    id: "roads-line",
    type: "line",
    source: "roads",
    layout: { visibility: "none" },
    paint: { "line-color": "#93c5fd", "line-width": 1.2, "line-opacity": 0.85 },
  });

  if (chmTilesAvailable) {
    map.addSource("chm", { type: "raster", url: `pmtiles://${new URL(CHM_PMTILES_URL, location.href)}`, tileSize: 256 });
    map.addLayer({
      id: "chm-raster",
      type: "raster",
      source: "chm",
      layout: { visibility: "none" },
      paint: { "raster-opacity": 0.75 },
    }, "roads-line");
  } else {
    document.querySelector("#layer-chm").disabled = true;
    document.querySelector("#layer-chm").parentElement.title = "CHM tiles not built yet";
  }

  map.on("click", "parcel-fill", (e) => {
    const pid = e.features?.[0]?.properties?.parcel_id;
    if (pid) selectParcel(pid, { fly: false });
  });
  map.on("mouseenter", "parcel-fill", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "parcel-fill", () => (map.getCanvas().style.cursor = ""));

  if (treeTilesAvailable) {
    map.addSource("tree-crowns", { type: "vector", url: `pmtiles://${new URL(TREE_CROWNS_PMTILES_URL, location.href)}` });
    map.addSource("tree-tops", { type: "vector", url: `pmtiles://${new URL(TREE_TOPS_PMTILES_URL, location.href)}` });

    // Treetops: small restrained circles, fading in starting just below
    // their minzoom so they don't pop in abruptly.
    map.addLayer({
      id: "tree-tops-circle",
      type: "circle",
      source: "tree-tops",
      "source-layer": "tree_tops",
      minzoom: TREETOPS_MINZOOM,
      paint: {
        "circle-radius": 2.2,
        "circle-color": "#a3e635",
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], TREETOPS_FADE_ZOOM, 0, TREETOPS_FADE_ZOOM + 0.5, 0.55, CROWNS_MINZOOM + 0.75, 0.35],
      },
    });

    // Crowns are the high-zoom hero layer: subtle/near-transparent by
    // default (real aerial imagery shows through), brighten distinctly on
    // hover, and the selected crown/treetop dominates everything else --
    // deliberately NOT the green/yellow/red opportunity-score heatmap look.
    map.addLayer({
      id: "tree-crowns-fill",
      type: "fill",
      source: "tree-crowns",
      "source-layer": "tree_crowns",
      minzoom: CROWNS_MINZOOM,
      paint: {
        "fill-color": "#eab308",
        "fill-opacity": [
          "interpolate", ["linear"], ["zoom"],
          CROWNS_MINZOOM, 0,
          CROWNS_MINZOOM + 0.5, ["case", ["boolean", ["feature-state", "hover"], false], 0.30, 0.08],
        ],
      },
    });
    map.addLayer({
      id: "tree-crowns-outline",
      type: "line",
      source: "tree-crowns",
      "source-layer": "tree_crowns",
      minzoom: CROWNS_MINZOOM,
      paint: {
        "line-color": ["case", ["boolean", ["feature-state", "hover"], false], "#fde68a", "#f8fafc"],
        "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 1.6, 0.5],
        "line-opacity": [
          "interpolate", ["linear"], ["zoom"],
          CROWNS_MINZOOM, 0,
          CROWNS_MINZOOM + 0.5, ["case", ["boolean", ["feature-state", "hover"], false], 0.95, 0.45],
        ],
      },
    });
    map.addLayer({
      id: "tree-crown-selected-outline",
      type: "line",
      source: "tree-crowns",
      "source-layer": "tree_crowns",
      filter: ["==", ["get", "tree_id"], "__none__"],
      paint: { "line-color": "#facc15", "line-width": 3.5, "line-opacity": 1 },
    });
    map.addLayer({
      id: "tree-crown-selected-fill",
      type: "fill",
      source: "tree-crowns",
      "source-layer": "tree_crowns",
      filter: ["==", ["get", "tree_id"], "__none__"],
      paint: { "fill-color": "#facc15", "fill-opacity": 0.28 },
    });

    let hoveredTreeFeatureId = null;
    map.on("click", "tree-crowns-fill", (e) => {
      if (map.getZoom() < CROWNS_INTERACTIVE_MINZOOM) return; // hover/click gated to interactive zoom
      const props = e.features?.[0]?.properties;
      if (props) selectTree(props);
    });
    map.on("mouseenter", "tree-crowns-fill", () => {
      if (map.getZoom() >= CROWNS_INTERACTIVE_MINZOOM) map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "tree-crowns-fill", () => {
      map.getCanvas().style.cursor = "";
      if (hoveredTreeFeatureId !== null) {
        map.setFeatureState({ source: "tree-crowns", sourceLayer: "tree_crowns", id: hoveredTreeFeatureId }, { hover: false });
        hoveredTreeFeatureId = null;
      }
    });

    map.on("mousemove", "tree-crowns-fill", (e) => {
      if (map.getZoom() < CROWNS_INTERACTIVE_MINZOOM) return;
      const feature = e.features?.[0];
      if (!feature) return;
      if (hoveredTreeFeatureId !== feature.id) {
        if (hoveredTreeFeatureId !== null) {
          map.setFeatureState({ source: "tree-crowns", sourceLayer: "tree_crowns", id: hoveredTreeFeatureId }, { hover: false });
        }
        hoveredTreeFeatureId = feature.id;
        map.setFeatureState({ source: "tree-crowns", sourceLayer: "tree_crowns", id: hoveredTreeFeatureId }, { hover: true });
      }
      showTreeHoverTooltip(e, feature.properties);
    });
    map.on("mouseleave", "tree-crowns-fill", hideTreeHoverTooltip);
  } else {
    console.warn("Tree crown/treetop layers not added -- PMTiles unavailable.");
  }

  // Aerial imagery at high zoom, cartographic basemap otherwise -- a
  // simple crossfade on the "zoom" event (no extra tile fetches beyond
  // the two raster sources already registered).
  let imageryActive = false;
  const updateBasemap = () => {
    const wantImagery = map.getZoom() >= IMAGERY_MINZOOM;
    if (wantImagery === imageryActive) return;
    imageryActive = wantImagery;
    map.setLayoutProperty("satellite", "visibility", wantImagery ? "visible" : "none");
    map.setLayoutProperty("osm", "visibility", wantImagery ? "none" : "visible");
  };
  map.on("zoom", updateBasemap);
  updateBasemap();

  // E05.10.B timing: first idle after style/sources settle, and first
  // render with the parcel-fill layer actually painting features (not
  // just an empty/not-yet-loaded tile).
  map.once("idle", () => performance.mark("app:map-idle"));
  const markUsableOnce = () => {
    if (window.__mapUsableMarked) return;
    if (map.queryRenderedFeatures({ layers: ["parcel-fill"] }).length > 0) {
      window.__mapUsableMarked = true;
      performance.mark("app:map-usable");
    }
  };
  map.on("render", markUsableOnce);
});

// --- Load attribute index, wire up UI ---
fetch(INDEX_URL)
  .then((r) => r.json())
  .then((rows) => {
    parcelIndex = rows;
    for (const row of rows) indexById.set(row.parcel_id, row);
    document.querySelector("#result-count").textContent = `${rows.length} parcels`;
    renderList();
    performance.mark("app:list-rendered"); // E05.10.B timing
    renderShortlistDrawer();
    saveShortlist();
  });

// Layer toggles
document.querySelector("#layer-score").addEventListener("change", (e) => {
  map.setLayoutProperty("parcel-fill", "visibility", e.target.checked ? "visible" : "none");
});
document.querySelector("#layer-boundaries").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  map.setLayoutProperty("parcel-outline", "visibility", v);
  map.setLayoutProperty("parcel-outline-provisional", "visibility", v);
  map.setLayoutProperty("parcel-selected-outline", "visibility", v);
});
document.querySelector("#layer-chm").addEventListener("change", (e) => {
  if (map.getLayer("chm-raster")) map.setLayoutProperty("chm-raster", "visibility", e.target.checked ? "visible" : "none");
});
document.querySelector("#layer-roads").addEventListener("change", (e) => {
  map.setLayoutProperty("roads-line", "visibility", e.target.checked ? "visible" : "none");
});

// Filters panel
document.querySelector("#filters-toggle").addEventListener("click", (e) => {
  const body = document.querySelector("#filters-body");
  const expanded = e.currentTarget.getAttribute("aria-expanded") === "true";
  e.currentTarget.setAttribute("aria-expanded", String(!expanded));
  body.hidden = expanded;
});
document.querySelector("#f-score").addEventListener("input", (e) => {
  filters.minScore = Number(e.target.value);
  document.querySelector("#f-score-val").textContent = e.target.value;
  applyFilters();
});
document.querySelector("#f-acres").addEventListener("input", (e) => { filters.minAcres = Number(e.target.value) || 0; applyFilters(); });
document.querySelector("#f-wooded").addEventListener("input", (e) => { filters.minWooded = Number(e.target.value) || 0; applyFilters(); });
document.querySelector("#f-canopy").addEventListener("input", (e) => { filters.minCanopyP90 = Number(e.target.value) || 0; applyFilters(); });
document.querySelector("#f-road").addEventListener("input", (e) => {
  filters.maxRoadDistance = e.target.value === "" ? null : Number(e.target.value);
  applyFilters();
});
document.querySelector("#f-continuity").addEventListener("input", (e) => {
  filters.minContinuityPct = Number(e.target.value);
  document.querySelector("#f-continuity-val").textContent = `${e.target.value}%`;
  applyFilters();
});
document.querySelector("#f-full-coverage").addEventListener("change", (e) => { filters.fullCoverageOnly = e.target.checked; applyFilters(); });
document.querySelector("#f-exclude-fallback").addEventListener("change", (e) => { filters.excludeFallback = e.target.checked; applyFilters(); });
document.querySelector("#filters-reset").addEventListener("click", () => {
  filters.minScore = 0; filters.minAcres = 0; filters.minWooded = 0; filters.minCanopyP90 = 0;
  filters.maxRoadDistance = null; filters.minContinuityPct = 0; filters.fullCoverageOnly = false; filters.excludeFallback = false;
  document.querySelector("#f-score").value = 0; document.querySelector("#f-score-val").textContent = "0";
  document.querySelector("#f-acres").value = 0;
  document.querySelector("#f-wooded").value = 0;
  document.querySelector("#f-canopy").value = 0;
  document.querySelector("#f-road").value = "";
  document.querySelector("#f-continuity").value = 0; document.querySelector("#f-continuity-val").textContent = "0%";
  document.querySelector("#f-full-coverage").checked = false;
  document.querySelector("#f-exclude-fallback").checked = false;
  applyFilters();
});

// Detail panel close
document.querySelector("#detail-close").addEventListener("click", () => {
  document.querySelector("#detail-panel").hidden = true;
  selectedId = null;
  document.querySelectorAll(".result-row.selected").forEach((el) => el.classList.remove("selected"));
  if (map.getLayer("parcel-selected-outline")) map.setFilter("parcel-selected-outline", ["==", ["get", "parcel_id"], "__none__"]);
});

// Tree detail panel close
document.querySelector("#tree-detail-close").addEventListener("click", closeTreeDetailPanel);

// Shortlist drawer
document.querySelector("#shortlist-toggle").addEventListener("click", () => {
  const drawer = document.querySelector("#shortlist-drawer");
  drawer.hidden = !drawer.hidden;
  if (!drawer.hidden) renderShortlistDrawer();
});
document.querySelector("#shortlist-close").addEventListener("click", () => {
  document.querySelector("#shortlist-drawer").hidden = true;
});
document.querySelector("#shortlist-export-csv").addEventListener("click", exportShortlistCSV);
document.querySelector("#shortlist-export-geojson").addEventListener("click", exportShortlistGeoJSON);

saveShortlist(); // sync the count badge on load
