
/* Pin Flyover (MVP)
   - Map: MapLibre GL JS + OpenFreeMap style (free public instance)
   - Terrain DEM: Mapzen/Tilezen Terrain Tiles on AWS (terrarium PNG)
   - Pins: Tap PIN -> single-shot geolocation -> add point -> connect line
   - Flyover: camera follows the line (close / adventurous), duration AUTO (30–90s) or manual
*/

const $ = (q) => document.querySelector(q);

const STORAGE_KEY = "pinFlyover:v1";
const DEFAULT_CENTER = [137.214, 36.695]; // Toyama-ish
const DEFAULT_ZOOM = 11.5;

const UI = {
  btnPin: $("#btnPin"),
  btnPlay: $("#btnPlay"),
  btnStop: $("#btnStop"),
  btnClear: $("#btnClear"),
  btnLocate: $("#btnLocate"),
  pinList: $("#pinList"),
  pinCount: $("#pinCount"),
  gpsHint: $("#gpsHint"),
  durationMode: $("#durationMode"),
  autoHint: $("#autoHint"),
  btnExport: $("#btnExport"),
  fileImport: $("#fileImport"),
  toast: $("#toast"),
};

let state = {
  pins: [],
  lastFix: null,
  playing: false,
  playRaf: null,
  playStartMs: 0,
  playDurationMs: 0,
  path: [], // densified
};

function toast(msg, ms=2200){
  UI.toast.textContent = msg;
  UI.toast.hidden = false;
  clearTimeout(UI.toast._t);
  UI.toast._t = setTimeout(() => UI.toast.hidden = true, ms);
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

// Haversine distance (meters)
function distM(a, b){
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s1 = Math.sin(dLat/2);
  const s2 = Math.sin(dLon/2);
  const x = s1*s1 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*s2*s2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function bearingDeg(a, b){
  const toRad = (d)=> d*Math.PI/180;
  const toDeg = (r)=> r*180/Math.PI;
  const [lon1, lat1] = a.map(toRad);
  const [lon2, lat2] = b.map(toRad);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  let brng = toDeg(Math.atan2(y, x));
  brng = (brng + 360) % 360;
  return brng;
}

function formatMeters(m){
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m/1000).toFixed(2)}km`;
}

function nowIso(){
  return new Date().toISOString();
}

function save(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ pins: state.pins }));
}
function load(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const obj = JSON.parse(raw);
    if (Array.isArray(obj?.pins)) state.pins = obj.pins;
  }catch(e){
    console.warn(e);
  }
}

function exportJson(){
  const blob = new Blob([JSON.stringify({ pins: state.pins }, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pin-flyover-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJson(file){
  const fr = new FileReader();
  fr.onload = () => {
    try{
      const obj = JSON.parse(fr.result);
      if(!Array.isArray(obj?.pins)) throw new Error("pins not found");
      state.pins = obj.pins.filter(p => p && Array.isArray(p.lngLat) && p.lngLat.length===2);
      save();
      renderAll();
      toast("Imported!");
    }catch(e){
      console.warn(e);
      toast("Import failed: invalid JSON");
    }
  };
  fr.readAsText(file);
}

/* ---------- Map ---------- */
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/3d", // free public style
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  pitch: 65,
  bearing: 20,
  attributionControl: true,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

map.on("load", () => {
  // Add free DEM tiles (Terrarium) from Tilezen terrain tiles on AWS.
  // Docs/registry: https://registry.opendata.aws/terrain-tiles/
  // Tile URL commonly used: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
  try{
    map.addSource("dem-terrain", {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      tileSize: 256,
      encoding: "terrarium",
      attribution: "Terrain: Mapzen/Tilzen (AWS terrain tiles)",
      maxzoom: 15
    });

    map.setTerrain({ source: "dem-terrain", exaggeration: 1.4 });

    // optional hillshade (helps depth)
    map.addLayer({
      id: "hillshade",
      type: "hillshade",
      source: "dem-terrain",
      paint: {
        "hillshade-exaggeration": 0.3,
      }
    }, findFirstSymbolLayerId());
  }catch(e){
    console.warn("Terrain unavailable:", e);
  }

  // Sources/layers for pins and line
  map.addSource("pins", { type: "geojson", data: pinsToGeoJSON() });
  map.addLayer({
    id: "pin-circles",
    type: "circle",
    source: "pins",
    paint: {
      "circle-radius": 7,
      "circle-stroke-width": 2,
      "circle-opacity": 0.95,
      "circle-stroke-opacity": 0.95,
    }
  });

  map.addLayer({
    id: "pin-labels",
    type: "symbol",
    source: "pins",
    layout: {
      "text-field": ["get","label"],
      "text-size": 12,
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-optional": true
    },
    paint: {
      "text-halo-width": 1.2,
      "text-halo-blur": 0.6
    }
  });

  map.addSource("route", { type: "geojson", data: routeToGeoJSON() });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout: {
      "line-join": "round",
      "line-cap": "round"
    },
    paint: {
      "line-width": 4,
      "line-opacity": 0.90
    }
  });

  map.on("click", "pin-circles", (e) => {
    const f = e.features?.[0];
    if(!f) return;
    const id = f.properties?.id;
    const p = state.pins.find(x => x.id === id);
    if(p){
      map.easeTo({ center: p.lngLat, zoom: Math.max(map.getZoom(), 15), duration: 450 });
      toast(p.name || "Pin");
    }
  });

  renderAll();
});

function findFirstSymbolLayerId(){
  const layers = map.getStyle()?.layers || [];
  for (const l of layers){
    if (l.type === "symbol") return l.id;
  }
  return undefined;
}

function pinsToGeoJSON(){
  return {
    type:"FeatureCollection",
    features: state.pins.map((p, idx) => ({
      type:"Feature",
      geometry:{ type:"Point", coordinates: p.lngLat },
      properties:{
        id: p.id,
        label: String(idx+1),
        name: p.name || `Pin ${idx+1}`
      }
    }))
  };
}

function routeToGeoJSON(){
  if(state.pins.length < 2){
    return { type:"FeatureCollection", features:[] };
  }
  return {
    type:"FeatureCollection",
    features:[{
      type:"Feature",
      geometry:{ type:"LineString", coordinates: state.pins.map(p => p.lngLat) },
      properties:{}
    }]
  };
}

function updateMapData(){
  if(!map?.isStyleLoaded?.()) return;
  const sPins = map.getSource("pins");
  const sRoute = map.getSource("route");
  if (sPins) sPins.setData(pinsToGeoJSON());
  if (sRoute) sRoute.setData(routeToGeoJSON());
}

/* ---------- UI rendering ---------- */
function renderList(){
  UI.pinCount.textContent = String(state.pins.length);
  UI.pinList.innerHTML = "";
  if(state.pins.length === 0){
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<div class="meta"><div class="name">No pins yet</div><div class="small">Tap PIN to add your first point.</div></div>`;
    UI.pinList.appendChild(div);
    return;
  }

  for (let i=0; i<state.pins.length; i++){
    const p = state.pins[i];
    const row = document.createElement("div");
    row.className = "item";

    const name = escapeHtml(p.name || `Pin ${i+1}`);
    const note = escapeHtml(p.note || "");
    const acc = (typeof p.accuracyM === "number") ? `±${Math.round(p.accuracyM)}m` : "--";
    const t = p.time ? new Date(p.time).toLocaleString() : "--";
    const coords = `${p.lngLat[1].toFixed(5)}, ${p.lngLat[0].toFixed(5)}`;

    row.innerHTML = `
      <div class="meta">
        <div class="name">${i+1}. ${name}</div>
        <div class="small">${coords} • ${acc} • ${t}</div>
        ${note ? `<div class="small">${note}</div>` : ``}
      </div>
      <div class="actions">
        <button class="iconBtn" data-act="up" ${i===0?"disabled":""} title="up">↑</button>
        <button class="iconBtn" data-act="down" ${i===state.pins.length-1?"disabled":""} title="down">↓</button>
        <button class="iconBtn" data-act="edit" title="edit">✎</button>
        <button class="iconBtn" data-act="del" title="delete">🗑</button>
      </div>
    `;
    row.querySelectorAll("button").forEach(btn=>{
      btn.addEventListener("click",(ev)=>{
        const act = btn.dataset.act;
        if(act==="up") swap(i, i-1);
        if(act==="down") swap(i, i+1);
        if(act==="del") removePin(i);
        if(act==="edit") editPin(i);
      }, {passive:true});
    });

    row.addEventListener("click", (ev)=>{
      // ignore clicks on buttons
      if(ev.target?.closest("button")) return;
      map.easeTo({ center: p.lngLat, zoom: Math.max(map.getZoom(), 15), duration: 420 });
    });

    UI.pinList.appendChild(row);
  }
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function swap(a,b){
  if(b<0 || b>=state.pins.length) return;
  const tmp = state.pins[a];
  state.pins[a] = state.pins[b];
  state.pins[b] = tmp;
  save();
  renderAll();
}

function removePin(i){
  state.pins.splice(i,1);
  save();
  renderAll();
}

async function editPin(i){
  const p = state.pins[i];
  const name = prompt("Pin name", p.name || `Pin ${i+1}`);
  if(name === null) return;
  const note = prompt("Note (optional)", p.note || "");
  if(note === null) return;
  p.name = name.trim();
  p.note = note.trim();
  save();
  renderAll();
}

function updateButtons(){
  UI.btnPlay.disabled = state.pins.length < 2 || state.playing;
  UI.btnStop.disabled = !state.playing;
  UI.btnPin.disabled = state.playing;
  UI.btnClear.disabled = state.pins.length === 0 || state.playing;
}

function computeAutoDurationSec(){
  const N = state.pins.length;
  if(N < 2) return 30;
  let Dm = 0;
  for(let i=1;i<N;i++) Dm += distM(state.pins[i-1].lngLat, state.pins[i].lngLat);
  const D = Dm/1000; // km

  // Heuristic: distance + complexity (pins)
  const T = 20 + 8*Math.log2(Math.max(2,N)) + 12*Math.sqrt(Math.max(0.01, D));
  return clamp(Math.round(T), 30, 90);
}

function getSelectedDurationSec(){
  const mode = UI.durationMode.value;
  if(mode === "auto") return computeAutoDurationSec();
  const v = Number(mode);
  if(Number.isFinite(v)) return clamp(v, 30, 90);
  return 60;
}

function renderAutoHint(){
  const t = computeAutoDurationSec();
  UI.autoHint.textContent = `AUTO: ${t}s`;
}

function renderAll(){
  renderList();
  renderAutoHint();
  updateMapData();
  updateButtons();
}

/* ---------- Geolocation Pin ---------- */
function setGpsHint(text){ UI.gpsHint.textContent = `GPS: ${text}`; }

async function addPinFromGPS(){
  if(!navigator.geolocation){
    toast("Geolocation not supported");
    return;
  }
  setGpsHint("requesting…");
  UI.btnPin.disabled = true;

  const opts = { enableHighAccuracy: true, timeout: 9000, maximumAge: 0 };

  navigator.geolocation.getCurrentPosition(
    (pos)=>{
      const { latitude, longitude, accuracy } = pos.coords;
      state.lastFix = { latitude, longitude, accuracy };
      const id = crypto?.randomUUID?.() || String(Date.now() + Math.random());
      const idx = state.pins.length + 1;

      const p = {
        id,
        lngLat: [longitude, latitude],
        accuracyM: accuracy,
        time: pos.timestamp ? new Date(pos.timestamp).toISOString() : nowIso(),
        name: `Pin ${idx}`,
        note: "",
      };

      // quality guard
      if(typeof accuracy === "number" && accuracy > 80){
        toast(`Accuracy is low (±${Math.round(accuracy)}m). Consider moving to open sky and try again.`);
      }else{
        toast(`Pinned! (±${Math.round(accuracy)}m)`);
      }

      state.pins.push(p);
      save();
      renderAll();

      // Gentle camera move to new pin
      map.easeTo({ center: p.lngLat, zoom: Math.max(map.getZoom(), 15), duration: 500 });

      setGpsHint(`OK ±${Math.round(accuracy)}m`);
      UI.btnPin.disabled = false;
    },
    (err)=>{
      console.warn(err);
      const msg = err.code === 1 ? "Permission denied" :
                  err.code === 2 ? "Position unavailable" :
                  err.code === 3 ? "Timeout" : "Error";
      setGpsHint(msg);
      toast(`GPS error: ${msg}`);
      UI.btnPin.disabled = false;
    },
    opts
  );
}

/* ---------- Flyover ---------- */
function densifyPath(coords){
  // Insert points so camera motion is smooth.
  // Strategy: split each segment into ~every 25m (clamped).
  const out = [];
  for(let i=0;i<coords.length-1;i++){
    const a = coords[i];
    const b = coords[i+1];
    const d = distM(a,b);
    const step = clamp(d / 25, 2, 120); // number of pieces
    for(let s=0;s<step;s++){
      const t = s/step;
      out.push([ a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t ]);
    }
  }
  out.push(coords[coords.length-1]);
  return out;
}

function startFlyover(){
  if(state.pins.length < 2 || state.playing) return;

  const durationSec = getSelectedDurationSec();
  state.playDurationMs = durationSec * 1000;
  state.playStartMs = performance.now();
  state.playing = true;

  // Build path
  const coords = state.pins.map(p => p.lngLat);
  state.path = densifyPath(coords);

  // Prep camera
  map.easeTo({
    center: state.path[0],
    zoom: 15.8,
    pitch: 72,
    bearing: 0,
    duration: 500
  });

  updateButtons();
  toast(`Flyover: ${durationSec}s (Tip: iPhone screen recording to save video)`);

  const tick = (now)=>{
    if(!state.playing) return;
    const t = clamp((now - state.playStartMs) / state.playDurationMs, 0, 1);

    // ease-in-out
    const te = t<0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;

    const idx = Math.floor(te * (state.path.length-1));
    const p = state.path[idx];
    const pNext = state.path[Math.min(idx+1, state.path.length-1)];
    const brg = bearingDeg(p, pNext);

    // Close/adventurous style (②): keep zoomed in, look ahead
    // Zoom slightly varies with progress and segment length for comfort.
    const zoom = 15.6 + 0.4*Math.sin(te*Math.PI);
    const pitch = 72;

    map.jumpTo({ center: p, bearing: brg, pitch, zoom });

    if(t >= 1){
      stopFlyover(true);
      return;
    }
    state.playRaf = requestAnimationFrame(tick);
  };

  state.playRaf = requestAnimationFrame(tick);
}

function stopFlyover(soft=false){
  state.playing = false;
  if(state.playRaf) cancelAnimationFrame(state.playRaf);
  state.playRaf = null;
  updateButtons();
  if(!soft) toast("Stopped");
}

/* ---------- Events ---------- */
UI.btnPin.addEventListener("click", addPinFromGPS);
UI.btnPlay.addEventListener("click", startFlyover);
UI.btnStop.addEventListener("click", ()=>stopFlyover(false));
UI.btnClear.addEventListener("click", ()=>{
  if(!confirm("Clear all pins?")) return;
  state.pins = [];
  save();
  renderAll();
});
UI.btnLocate.addEventListener("click", ()=>{
  if(state.pins.length){
    map.easeTo({ center: state.pins[state.pins.length-1].lngLat, zoom: Math.max(map.getZoom(), 14), duration: 450 });
  }else{
    map.easeTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, duration: 450 });
  }
});

UI.durationMode.addEventListener("change", ()=>{
  renderAutoHint();
  toast(UI.durationMode.value==="auto" ? "Duration: AUTO" : `Duration: ${UI.durationMode.value}s`);
});

UI.btnExport.addEventListener("click", exportJson);
UI.fileImport.addEventListener("change", (e)=>{
  const f = e.target.files?.[0];
  if(!f) return;
  importJson(f);
  e.target.value = "";
});

/* ---------- Boot ---------- */
load();
renderAll();
setGpsHint("tap PIN");

