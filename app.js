// アドベンチャーノート（ピン＋3Dフライオーバー）
// v3: 日本語UI + Journal風デザイン + 写真の撮影時刻で自動割り当て + Flyover中オーバーレイ + JSON入出力 + 端末保存(IndexedDB)

const $ = (sel) => document.querySelector(sel);

const state = {
  map: null,
  pins: [], // {id, lat,lng, ts, acc, memo, photos:[{id, ts, name, dataUrl}]}
  activePinId: null,
  fly: { running:false, raf: null, start:0, duration:0, points:[], meta:[], nextOverlayAt:0, shown:new Set() },
  sourcesReady: false,
};

const DB_KEY_LIST = "ajn:saved:list";
const DB_KEY_PREFIX = "ajn:saved:item:";

function nowISO(){
  return new Date().toISOString();
}
function fmtTime(ts){
  const d = new Date(ts);
  const pad=(n)=>String(n).padStart(2,'0');
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function haversineKm(a,b){
  const R=6371;
  const toRad=(x)=>x*Math.PI/180;
  const dLat=toRad(b.lat-a.lat);
  const dLng=toRad(b.lng-a.lng);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(s)));
}
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

function toast(msg, ms=2200){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(()=>t.classList.add("hidden"), ms);
}

function genId(){
  return Math.random().toString(36).slice(2,10) + "-" + Date.now().toString(36);
}

// ---- Map init (MapLibre + OpenFreeMap + Terrain) ----
async function initMap(){
  const styleUrl = "https://tiles.openfreemap.org/styles/liberty"; // OpenFreeMap quick start
  const map = new maplibregl.Map({
    container: "map",
    style: styleUrl,
    center: [137.0, 36.6],
    zoom: 10,
    // 通常表示は見やすい「平面地図」
    pitch: 0,
    bearing: 0,
    antialias: true
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  map.on("load", () => {
    // Terrain source: Terrarium DEM tiles (public) - good for prototypes.
    // Note: For heavy use, consider hosting your own tiles.
    try{
      map.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: [
          "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        ],
        tileSize: 256,
        maxzoom: 14
      });
      // ※通常時は地形(3D)をOFF。フライオーバー時のみONにします。
    }catch(e){
      console.warn("terrain setup failed", e);
    }

    // Line source/layer
    map.addSource("route", {
      type: "geojson",
      data: { type:"FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      paint: {
        "line-width": 5,
        "line-opacity": 0.85,
        "line-color": "#ffcc66"
      }
    });

    // Pins source/layer
    map.addSource("pins", {
      type: "geojson",
      data: { type:"FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "pins-circle",
      type: "circle",
      source: "pins",
      paint: {
        "circle-radius": 8,
        "circle-color": "#7fe7c4",
        "circle-stroke-width": 2,
        "circle-stroke-color": "rgba(255,255,255,0.8)"
      }
    });

    map.on("click", "pins-circle", (e) => {
      const f = e.features?.[0];
      if(!f) return;
      const id = f.properties.id;
      setActivePin(id, true);
    });

    // Long-press delete (mobile)
    let pressTimer=null;
    map.on("touchstart", "pins-circle", (e) => {
      if(pressTimer) clearTimeout(pressTimer);
      const f = e.features?.[0];
      if(!f) return;
      const id = f.properties.id;
      pressTimer = setTimeout(()=>{
        if(confirm("このピンを削除しますか？")){
          deletePin(id);
        }
      }, 650);
    });
    map.on("touchend", "pins-circle", ()=>{ if(pressTimer) clearTimeout(pressTimer); });

    state.map = map;
    state.sourcesReady = true;
    renderAll();
    toast("準備OK。まず「現在地を記録」を押してみてください。", 2600);
  });
}

function enableFlyMode(){
  // フライオーバー時だけ3D地形＋高いピッチにする
  if(!state.map) return;
  try{
    if(state.map.getSource("terrain-dem")){
      state.map.setTerrain({ source: "terrain-dem", exaggeration: 1.4 });
    }
  }catch(e){
    console.warn("enableFlyMode terrain failed", e);
  }
}

function disableFlyMode(){
  // 通常時は平面に戻す（視認性優先）
  if(!state.map) return;
  try{ state.map.setTerrain(null); }catch(e){ /* ignore */ }
  try{
    state.map.easeTo({ pitch: 0, bearing: 0, duration: 450 });
  }catch(e){ /* ignore */ }
}

// ---- Rendering ----
function pinsToGeoJSON(){
  const feats = state.pins.map((p, idx)=>({
    type:"Feature",
    geometry:{ type:"Point", coordinates:[p.lng, p.lat] },
    properties:{ id:p.id, idx: idx+1 }
  }));
  return { type:"FeatureCollection", features: feats };
}
function routeToGeoJSON(){
  if(state.pins.length < 2) return { type:"FeatureCollection", features: [] };
  const coords = state.pins.map(p=>[p.lng, p.lat]);
  return {
    type:"FeatureCollection",
    features: [{
      type:"Feature",
      geometry:{ type:"LineString", coordinates: coords },
      properties:{}
    }]
  };
}

function updateMapSources(){
  if(!state.map || !state.sourcesReady) return;
  const map = state.map;
  const pinsSrc = map.getSource("pins");
  const routeSrc = map.getSource("route");
  if(pinsSrc) pinsSrc.setData(pinsToGeoJSON());
  if(routeSrc) routeSrc.setData(routeToGeoJSON());
}

function renderTimeline(){
  const el = $("#timeline");
  el.innerHTML = "";
  if(state.pins.length === 0){
    const empty = document.createElement("div");
    empty.className="smallhelp";
    empty.textContent = "まだピンがありません。旅先で「現在地を記録」を押してください。";
    el.appendChild(empty);
    return;
  }

  state.pins.forEach((p, idx)=>{
    const div = document.createElement("div");
    div.className = "titem" + (p.id===state.activePinId ? " active" : "");
    div.dataset.id = p.id;
    const badge = document.createElement("div");
    badge.className="badge";
    badge.textContent = String(idx+1);

    const meta = document.createElement("div");
    meta.className="tmeta";
    const name = document.createElement("div");
    name.className="tname";
    const photoCount = p.photos?.length || 0;
    const memoPreview = (p.memo||"").trim().slice(0, 28);
    name.textContent = memoPreview ? memoPreview : `ポイント ${idx+1}`;

    const sub = document.createElement("div");
    sub.className="tsub";
    const pills = [];
    pills.push({label: fmtTime(p.ts)});
    if(photoCount>0) pills.push({label:`写真 ${photoCount}枚`});
    if(p.acc!=null) pills.push({label:`誤差 ${Math.round(p.acc)}m`});
    pills.forEach(pl=>{
      const s = document.createElement("span");
      s.className="pill";
      s.textContent = pl.label;
      sub.appendChild(s);
    });

    meta.appendChild(name);
    meta.appendChild(sub);

    div.appendChild(badge);
    div.appendChild(meta);

    div.addEventListener("click", ()=>{
      setActivePin(p.id, true);
    });
    // Right-click delete on desktop
    div.addEventListener("contextmenu", (ev)=>{
      ev.preventDefault();
      if(confirm("このピンを削除しますか？")){
        deletePin(p.id);
      }
    });

    el.appendChild(div);
  });
}

function renderActiveEditor(){
  const memoBox = $("#memoBox");
  const strip = $("#photoStrip");
  const p = state.pins.find(x=>x.id===state.activePinId);
  memoBox.disabled = !p;
  memoBox.value = p?.memo || "";
  strip.innerHTML = "";
  if(!p) return;

  (p.photos||[]).forEach(ph=>{
    const img = document.createElement("img");
    img.className="thumb";
    img.src = ph.dataUrl;
    img.title = ph.name || "写真";
    img.addEventListener("click", ()=>{
      // remove photo
      if(confirm("この写真をこのピンから外しますか？")){
        p.photos = p.photos.filter(x=>x.id!==ph.id);
        renderAll();
      }
    });
    strip.appendChild(img);
  });
}

function updateDurationHint(){
  const hint = $("#durationHint");
  const auto = calcAutoDurationSec();
  hint.textContent = `自動: ${auto}秒`;
}

function renderAll(){
  updateMapSources();
  renderTimeline();
  renderActiveEditor();
  updateDurationHint();
}

// ---- Pin management ----
function setActivePin(id, flyTo){
  state.activePinId = id;
  const p = state.pins.find(x=>x.id===id);
  if(p && flyTo && state.map){
    const opts = { center:[p.lng,p.lat], zoom: 14, duration: 650 };
    if(!state.fly.running){
      opts.pitch = 0;
      opts.bearing = 0;
    }
    state.map.easeTo(opts);
  }
  renderAll();
}

function addPinFromPosition(pos){
  const { latitude, longitude, accuracy } = pos.coords;
  const ts = pos.timestamp ? new Date(pos.timestamp).toISOString() : nowISO();

  const pin = { id: genId(), lat: latitude, lng: longitude, ts, acc: accuracy ?? null, memo:"", photos:[] };
  state.pins.push(pin);
  setActivePin(pin.id, true);

  if(accuracy != null && accuracy > 60){
    toast(`精度が低めです（誤差 約${Math.round(accuracy)}m）。必要なら少し待ってもう一度。`, 3200);
  }else{
    toast("ピンを追加しました。", 1600);
  }

  // auto frame
  fitToPinsIfNeeded();
}

function fitToPinsIfNeeded(){
  if(!state.map) return;
  if(state.pins.length === 1){
    const p = state.pins[0];
    state.map.easeTo({ center:[p.lng,p.lat], zoom: 14, pitch: 0, bearing: 0, duration: 650 });
    return;
  }
  if(state.pins.length >= 2){
    const bounds = new maplibregl.LngLatBounds();
    state.pins.forEach(p=>bounds.extend([p.lng,p.lat]));
    state.map.fitBounds(bounds, { padding: 80, duration: 750, maxZoom: 15, pitch: 0, bearing: 0 });
  }
}

function deletePin(id){
  const idx = state.pins.findIndex(p=>p.id===id);
  if(idx<0) return;
  state.pins.splice(idx,1);
  if(state.activePinId===id){
    state.activePinId = state.pins[idx]?.id || state.pins[idx-1]?.id || null;
  }
  renderAll();
}

// ---- Geolocation (single shot) ----
async function pinCurrentLocation(){
  if(!navigator.geolocation){
    toast("このブラウザでは位置情報が使えません。", 2800);
    return;
  }
  toast("位置情報を取得中…（数秒）", 1400);

  const opts = { enableHighAccuracy: true, timeout: 9000, maximumAge: 0 };
  navigator.geolocation.getCurrentPosition(
    (pos)=> addPinFromPosition(pos),
    (err)=>{
      console.warn(err);
      if(err.code===1) toast("位置情報が許可されていません。設定から許可してください。", 3600);
      else if(err.code===3) toast("位置情報の取得がタイムアウトしました。屋外で再度お試しください。", 3200);
      else toast("位置情報の取得に失敗しました。", 2600);
    },
    opts
  );
}

// ---- Photo import & auto assign by capture time ----
async function readAsDataURL(file){
  return new Promise((res, rej)=>{
    const fr = new FileReader();
    fr.onload = ()=>res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

// resize to keep JSON reasonable
async function resizeDataUrl(dataUrl, maxSide=1280, quality=0.85){
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(()=>{});
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if(!w || !h) return dataUrl;
  const scale = Math.min(1, maxSide / Math.max(w,h));
  const cw = Math.round(w*scale);
  const ch = Math.round(h*scale);

  const canvas = document.createElement("canvas");
  canvas.width=cw; canvas.height=ch;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0,0,cw,ch);
  return canvas.toDataURL("image/jpeg", quality);
}

function nearestPinByTime(tsISO){
  const t = new Date(tsISO).getTime();
  let best=null, bestDt=Infinity;
  for(const p of state.pins){
    const pt = new Date(p.ts).getTime();
    const dt = Math.abs(pt - t);
    if(dt < bestDt){
      bestDt = dt; best = p;
    }
  }
  return best;
}

async function importPhotos(files){
  if(state.pins.length === 0){
    toast("先にピンをいくつか打ってから写真を読み込んでください。", 3200);
    return;
  }
  const list = Array.from(files || []);
  if(list.length===0) return;

  toast(`写真を処理中…（${list.length}枚）`, 2200);

  for(const file of list){
    let exifTime = null;
    try{
      const data = await exifr.parse(file, { tiff:true, exif:true, ifd0:true });
      // DateTimeOriginal is typical; fallback to CreateDate/ModifyDate
      const dt = data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate;
      if(dt instanceof Date) exifTime = dt.toISOString();
    }catch(e){
      // ignore
    }
    if(!exifTime){
      // fallback: file lastModified
      exifTime = new Date(file.lastModified || Date.now()).toISOString();
    }

    const dataUrl0 = await readAsDataURL(file);
    const dataUrl = await resizeDataUrl(dataUrl0);

    const pin = nearestPinByTime(exifTime) || state.pins[state.pins.length-1];
    pin.photos = pin.photos || [];
    pin.photos.push({
      id: genId(),
      ts: exifTime,
      name: file.name,
      dataUrl
    });
  }

  renderAll();
  toast("写真を割り当てました。タイムラインを確認してください。", 2600);
}

// ---- Flyover ----
function calcTotalDistanceKm(){
  if(state.pins.length < 2) return 0;
  let d=0;
  for(let i=1;i<state.pins.length;i++){
    d += haversineKm({lat:state.pins[i-1].lat, lng:state.pins[i-1].lng}, {lat:state.pins[i].lat, lng:state.pins[i].lng});
  }
  return d;
}
function calcAutoDurationSec(){
  const N = Math.max(1, state.pins.length);
  const D = calcTotalDistanceKm();
  // 20 + 8*log2(N) + 12*sqrt(D), clamp 30..90
  const t = 20 + 8*Math.log2(N) + 12*Math.sqrt(Math.max(0,D));
  return Math.round(clamp(t, 30, 90));
}

function densifyPins(stepMeters=35){
  // Create smooth path points along line segments.
  const pts = state.pins.map(p=>({lng:p.lng, lat:p.lat, id:p.id, ts:p.ts}));
  if(pts.length<2) return {points: pts, meta: []};

  const out=[];
  const meta=[]; // {pinId, atIndex}
  let idx=0;
  out.push({lng:pts[0].lng, lat:pts[0].lat});
  meta.push({pinId: pts[0].id, atIndex: 0});

  for(let i=1;i<pts.length;i++){
    const a = pts[i-1], b = pts[i];
    const distKm = haversineKm({lat:a.lat,lng:a.lng},{lat:b.lat,lng:b.lng});
    const distM = distKm*1000;
    const steps = Math.max(1, Math.floor(distM/stepMeters));
    for(let s=1;s<=steps;s++){
      const t = s/steps;
      const lng = a.lng + (b.lng-a.lng)*t;
      const lat = a.lat + (b.lat-a.lat)*t;
      out.push({lng,lat});
      idx++;
    }
    meta.push({pinId: b.id, atIndex: idx});
  }
  return {points: out, meta};
}

function getDurationSec(){
  const m = $("#durationMode").value;
  if(m==="auto") return calcAutoDurationSec();
  return parseInt(m,10) || 60;
}

function showOverlayForPin(pinId){
  const p = state.pins.find(x=>x.id===pinId);
  if(!p) return;

  const idx = state.pins.findIndex(x=>x.id===pinId);
  $("#ovTitle").textContent = `ポイント ${idx+1}`;
  const meta = `${fmtTime(p.ts)}  •  写真 ${(p.photos?.length||0)}枚`;
  $("#ovMeta").textContent = meta;

  const memo = (p.memo||"").trim();
  $("#ovMemo").textContent = memo ? memo : "（メモなし）";

  const img = $("#ovImg");
  const ph = p.photos?.[0];
  if(ph?.dataUrl){
    img.src = ph.dataUrl;
    img.classList.remove("hidden");
  }else{
    img.classList.add("hidden");
    img.removeAttribute("src");
  }

  $("#overlay").classList.remove("hidden");
  clearTimeout(showOverlayForPin._timer);
  showOverlayForPin._timer = setTimeout(()=>$("#overlay").classList.add("hidden"), 2500);
}

function currentPinIdFromMeta(pointIndex){
  // meta is ordered by pin order; return the latest pin whose atIndex <= pointIndex
  let last = null;
  for(const m of state.fly.meta){
    if(m.atIndex <= pointIndex) last = m.pinId;
    else break;
  }
  return last;
}

function scrollActiveTimelineIntoView(){
  const wrap = $("#timeline");
  const active = wrap?.querySelector?.(".titem.active");
  if(!wrap || !active) return;
  try{
    active.scrollIntoView({ behavior: "smooth", block: "center" });
  }catch(e){
    // older iOS fallback
    wrap.scrollTop = Math.max(0, active.offsetTop - wrap.clientHeight/2);
  }
}

function setFlyActivePin(pinId){
  // flyover中は地図を動かさず、ハイライト＋自動スクロールだけ更新
  if(state.activePinId === pinId) return;
  state.activePinId = pinId;
  renderTimeline();
  scrollActiveTimelineIntoView();
}

function startFlyover(){
  if(state.fly.running){
    stopFlyover();
    return;
  }
  if(!state.map || state.pins.length < 2){
    toast("フライオーバーにはピンが2つ以上必要です。", 2600);
    return;
  }

  const dur = getDurationSec();
  const {points, meta} = densifyPins(35); // smoother
  if(points.length < 2){
    toast("ルートが短すぎます。", 2200);
    return;
  }

  state.fly.running = true;
  enableFlyMode();
  state.fly.start = performance.now();
  state.fly.duration = dur * 1000;
  state.fly.points = points;
  state.fly.meta = meta;
  state.fly.shown = new Set();

  $("#btnFly").textContent = "フライオーバー停止 ■";
  $("#overlay").classList.add("hidden");

  // set cinematic-ish camera for option ② (closer, forward-looking)
  state.map.easeTo({ pitch: 72, zoom: 15.2, duration: 700 });

  const step = (tNow) => {
    if(!state.fly.running) return;
    const t = tNow - state.fly.start;
    const p = clamp(t / state.fly.duration, 0, 1);
    const idx = Math.floor(p * (state.fly.points.length - 1));
    const cur = state.fly.points[idx];
    const next = state.fly.points[Math.min(idx+8, state.fly.points.length-1)];

    // bearing toward next point
    const bearing = calcBearing(cur, next);

    // zoom dynamics: small pulse based on speed/curvature-ish
    const z = 15.2;

    state.map.jumpTo({ center: [cur.lng, cur.lat], bearing, zoom: z, pitch: 72 });

    // Overlay: show at each pin arrival index (meta atIndex)
    for(const m of state.fly.meta){
      if(!state.fly.shown.has(m.pinId) && idx >= m.atIndex){
        state.fly.shown.add(m.pinId);
        showOverlayForPin(m.pinId);
      }
    }

    // Timeline: auto-scroll so "今どこ" が分かる
    const curPinId = currentPinIdFromMeta(idx);
    if(curPinId) setFlyActivePin(curPinId);

    if(t >= state.fly.duration){
      stopFlyover(true);
      return;
    }
    state.fly.raf = requestAnimationFrame(step);
  };
  state.fly.raf = requestAnimationFrame(step);

  toast(`フライオーバー開始（${dur}秒）`, 1600);
}

function stopFlyover(ended=false){
  state.fly.running = false;
  if(state.fly.raf) cancelAnimationFrame(state.fly.raf);
  state.fly.raf = null;
  $("#btnFly").textContent = "フライオーバー再生 ▶";
  if(ended) toast("再生が完了しました。", 1800);
  disableFlyMode();
}

function calcBearing(a,b){
  // a,b: {lat,lng}
  const toRad=(x)=>x*Math.PI/180;
  const toDeg=(x)=>x*180/Math.PI;
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const dLng=toRad(b.lng-a.lng);
  const y=Math.sin(dLng)*Math.cos(lat2);
  const x=Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLng);
  let brng = toDeg(Math.atan2(y,x));
  brng = (brng + 360) % 360;
  return brng;
}

// ---- Save/Load (IndexedDB via idb-keyval) ----
async function getSavedList(){
  const list = await idbKeyval.get(DB_KEY_LIST);
  return Array.isArray(list) ? list : [];
}
async function setSavedList(list){
  await idbKeyval.set(DB_KEY_LIST, list);
}
function buildSnapshot(){
  return {
    version: 3,
    title: buildDefaultTitle(),
    createdAt: nowISO(),
    updatedAt: nowISO(),
    pins: state.pins
  };
}
function buildDefaultTitle(){
  const d = new Date();
  const pad=(n)=>String(n).padStart(2,'0');
  return `旅 ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function refreshSavedSelect(){
  const sel = $("#savedSelect");
  const list = await getSavedList();
  sel.innerHTML = "";
  if(list.length===0){
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（保存済みデータなし）";
    sel.appendChild(opt);
    return;
  }
  list.forEach(item=>{
    const opt = document.createElement("option");
    opt.value = item.key;
    opt.textContent = `${item.title}（更新: ${fmtTime(item.updatedAt)}）`;
    sel.appendChild(opt);
  });
}

async function saveToDevice(){
  const snap = buildSnapshot();
  const list = await getSavedList();

  // if a saved item selected, overwrite; else create new
  const selKey = $("#savedSelect").value || null;
  let key = selKey;
  if(!key || key===""){
    key = DB_KEY_PREFIX + genId();
    list.unshift({ key, title: snap.title, updatedAt: snap.updatedAt });
  }else{
    const idx = list.findIndex(x=>x.key===key);
    if(idx>=0){
      list[idx].updatedAt = snap.updatedAt;
      list[idx].title = snap.title;
    }else{
      list.unshift({ key, title: snap.title, updatedAt: snap.updatedAt });
    }
  }

  await idbKeyval.set(key, snap);
  await setSavedList(list);
  await refreshSavedSelect();
  $("#savedSelect").value = key;
  toast("端末に保存しました。", 2000);
}

async function loadFromDevice(){
  const key = $("#savedSelect").value;
  if(!key){ toast("読み込むデータがありません。", 2200); return; }
  const snap = await idbKeyval.get(key);
  if(!snap?.pins){ toast("データが壊れている可能性があります。", 2600); return; }
  state.pins = snap.pins;
  state.activePinId = state.pins[0]?.id || null;
  renderAll();
  fitToPinsIfNeeded();
  toast("読み込みました。", 1600);
}

async function deleteFromDevice(){
  const key = $("#savedSelect").value;
  if(!key){ toast("削除するデータがありません。", 2200); return; }
  if(!confirm("この保存データを削除しますか？")) return;

  await idbKeyval.del(key);
  let list = await getSavedList();
  list = list.filter(x=>x.key!==key);
  await setSavedList(list);
  await refreshSavedSelect();
  toast("削除しました。", 1600);
}

// ---- JSON Export/Import ----
function downloadText(filename, text){
  const blob = new Blob([text], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
}

function exportJSON(){
  const snap = buildSnapshot();
  snap.updatedAt = nowISO();
  const json = JSON.stringify(snap, null, 2);
  const d = new Date();
  const pad=(n)=>String(n).padStart(2,'0');
  const filename = `adventure-note-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  downloadText(filename, json);
  toast("JSONを書き出しました。", 1800);
}

async function importJSONFile(file){
  const text = await file.text();
  let obj=null;
  try{ obj = JSON.parse(text); }catch(e){
    toast("JSONの読み込みに失敗しました（形式が正しくありません）。", 3200);
    return;
  }
  if(!obj?.pins || !Array.isArray(obj.pins)){
    toast("このJSONは読み込めません（pinsがありません）。", 3200);
    return;
  }
  state.pins = obj.pins;
  state.activePinId = state.pins[0]?.id || null;
  renderAll();
  fitToPinsIfNeeded();
  toast("JSONを読み込みました。", 1800);
}

// ---- Clear/New ----
function newTrip(){
  if(state.pins.length>0 && !confirm("現在のデータをクリアして新しい旅を始めますか？")) return;
  stopFlyover();
  state.pins = [];
  state.activePinId = null;
  $("#memoBox").value = "";
  renderAll();
  toast("新しい旅を開始しました。", 1600);
}

// ---- Wire UI ----
function wireUI(){
  $("#btnPin").addEventListener("click", pinCurrentLocation);
  $("#btnFly").addEventListener("click", startFlyover);

  $("#memoBox").addEventListener("input", ()=>{
    const p = state.pins.find(x=>x.id===state.activePinId);
    if(!p) return;
    p.memo = $("#memoBox").value;
    renderTimeline();
  });

  $("#photoInput").addEventListener("change", (e)=>{
    importPhotos(e.target.files);
    e.target.value = "";
  });

  $("#durationMode").addEventListener("change", ()=>{
    updateDurationHint();
  });

  $("#btnSave").addEventListener("click", saveToDevice);
  $("#btnLoad").addEventListener("click", loadFromDevice);
  $("#btnDelete").addEventListener("click", deleteFromDevice);
  $("#btnExport").addEventListener("click", exportJSON);
  $("#jsonInput").addEventListener("change", async (e)=>{
    const f = e.target.files?.[0];
    if(f) await importJSONFile(f);
    e.target.value = "";
  });
  $("#btnNew").addEventListener("click", newTrip);

  // initial saved list
  refreshSavedSelect();
}

// ---- Boot ----
(async function boot(){
  wireUI();
  await initMap();
})();
