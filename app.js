// アドベンチャーノート（ピン軌跡） v6
// - 平面地図のみ（Flyoverなし）
// - ピンを時系列で線で接続 + 方向矢印（△）
// - 写真を後から読み込み：EXIF時刻/位置で自動配置（最寄りピンへ、なければ新規ピン）
// - 自動記録モード（例：3分ごと）
// - JSON入出力 / 端末保存（IndexedDB）

const $ = (sel) => document.querySelector(sel);
const { get, set, del, keys } = window.idbKeyval;

const state = {
  map: null,
  pins: [], // {id, lat,lng, ts, acc, memo, photos:[{id, ts, name, dataUrl, lat,lng}]}
  activePinId: null,
  photoMarkers: new Map(), // photoId -> Marker
  auto: { running:false, timer:null, intervalMs:180000 },
};

const STORAGE_PREFIX = "aj_v6:";
const MAX_PHOTO_EDGE = 640;   // medium
const THUMB_EDGE = 180;       // shown in timeline
const PHOTO_JPEG_QUALITY = 0.75;
const ATTACH_TIME_WINDOW_MS = 10 * 60 * 1000; // 10min

function uid(prefix="id"){
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function toast(msg, ms=2200){
  const el = $("#toast");
  if(!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>el.classList.remove("show"), ms);
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function fmtTime(iso){
  try{
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const da = String(d.getDate()).padStart(2,"0");
    const hh = String(d.getHours()).padStart(2,"0");
    const mm = String(d.getMinutes()).padStart(2,"0");
    return `${y}/${m}/${da} ${hh}:${mm}`;
  }catch{ return iso; }
}

function haversineKm(a,b){
  const R=6371;
  const toRad = (x)=>x*Math.PI/180;
  const dLat=toRad(b.lat-a.lat);
  const dLon=toRad(b.lng-a.lng);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

function bearingDeg(a,b){
  const toRad = (x)=>x*Math.PI/180;
  const toDeg = (x)=>x*180/Math.PI;
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const dLon=toRad(b.lng-a.lng);
  const y=Math.sin(dLon)*Math.cos(lat2);
  const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  let brng = toDeg(Math.atan2(y,x));
  brng = (brng+360)%360;
  return brng;
}

function sortPins(){
  state.pins.sort((p,q)=>new Date(p.ts)-new Date(q.ts));
}

function getActivePin(){
  return state.pins.find(p=>p.id===state.activePinId) || null;
}

function setActivePin(id){
  state.activePinId = id;
  renderTimeline();
  renderMemo();
  highlightPinOnMap();
}

function getPinsLineCoords(){
  sortPins();
  return state.pins.map(p=>[p.lng,p.lat]);
}

function routeDistanceKm(){
  sortPins();
  let d=0;
  for(let i=1;i<state.pins.length;i++){
    d += haversineKm(state.pins[i-1], state.pins[i]);
  }
  return d;
}

function computeArrowPoints(){
  // Create arrows every few segments (or by distance)
  sortPins();
  const pts = [];
  if(state.pins.length < 2) return pts;

  let accumKm = 0;
  let nextKm = 0.6; // place first arrow after 600m approx
  const stepKm = 0.8; // then every 800m
  for(let i=1;i<state.pins.length;i++){
    const a = state.pins[i-1];
    const b = state.pins[i];
    const segKm = haversineKm(a,b);
    // If segment is tiny, skip accumulation but keep for distance
    if(segKm <= 0) continue;
    let localStart = 0;
    while(accumKm + (segKm - localStart) >= nextKm){
      const need = nextKm - accumKm;
      const t = clamp((localStart + need)/segKm, 0, 1);
      const lat = a.lat + (b.lat-a.lat)*t;
      const lng = a.lng + (b.lng-a.lng)*t;
      const br = bearingDeg(a,b);
      pts.push({lat,lng,bearing:br});
      nextKm += stepKm;
    }
    accumKm += segKm;
  }

  // If route is short, place a couple by segment index
  if(pts.length === 0){
    const k = Math.max(1, Math.floor((state.pins.length-1)/3));
    for(let i=k;i<state.pins.length;i+=k){
      const a=state.pins[i-1], b=state.pins[i];
      const lat=(a.lat+b.lat)/2, lng=(a.lng+b.lng)/2;
      pts.push({lat,lng,bearing:bearingDeg(a,b)});
    }
  }
  return pts;
}

async function initMap(){
  const styleUrl = "https://tiles.openfreemap.org/styles/liberty";
  const map = new maplibregl.Map({
    container: "map",
    style: styleUrl,
    center: [137.2, 36.7],
    zoom: 11,
    pitch: 0,
    bearing: 0,
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }));
  map.addControl(new maplibregl.NavigationControl({ showCompass:true }), "top-left");

  map.on("load", () => {
    // Add arrow icon
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0,0,64,64);
    ctx.translate(32,32);
    // triangle pointing up
    ctx.beginPath();
    ctx.moveTo(0,-22);
    ctx.lineTo(18,18);
    ctx.lineTo(-18,18);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 238, 88, 0.95)"; // yellow-ish
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.stroke();
    map.addImage("dirArrow", canvas, { pixelRatio: 2 });

    // Sources
    map.addSource("route", { type:"geojson", data: emptyRoute() });
    map.addSource("arrows", { type:"geojson", data: emptyArrows() });
    map.addSource("pins", { type:"geojson", data: emptyPins() });

    // Route line
    map.addLayer({
      id:"route-line",
      type:"line",
      source:"route",
      layout:{ "line-join":"round", "line-cap":"round" },
      paint:{
        "line-color":"#ffee58",
        "line-width":5,
        "line-opacity":0.9
      }
    });

    // Direction arrows
    map.addLayer({
      id:"route-arrows",
      type:"symbol",
      source:"arrows",
      layout:{
        "icon-image":"dirArrow",
        "icon-size":0.55,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-rotation-alignment":"map",
        "icon-rotate":["get","bearing"]
      }
    });

    // Pins
    map.addLayer({
      id:"pins-circle",
      type:"circle",
      source:"pins",
      paint:{
        "circle-radius":6,
        "circle-color":"#34d399",
        "circle-stroke-width":2,
        "circle-stroke-color":"rgba(0,0,0,0.35)"
      }
    });

    // Active pin ring
    map.addLayer({
      id:"pins-active",
      type:"circle",
      source:"pins",
      paint:{
        "circle-radius":10,
        "circle-color":"rgba(59,130,246,0.25)",
        "circle-stroke-width":2,
        "circle-stroke-color":"rgba(59,130,246,0.9)"
      },
      filter:["==",["get","id"], "__none__"]
    });

    map.on("click","pins-circle",(e)=>{
      const f = e.features?.[0];
      if(!f) return;
      setActivePin(f.properties.id);
    });

    renderMapData(true);
  });

  state.map = map;
}

function emptyRoute(){
  return { type:"FeatureCollection", features:[ {type:"Feature", geometry:{type:"LineString", coordinates:[]}, properties:{}} ] };
}
function emptyArrows(){
  return { type:"FeatureCollection", features:[] };
}
function emptyPins(){
  return { type:"FeatureCollection", features:[] };
}

function fitToPins(padding=60){
  const map = state.map;
  if(!map || state.pins.length===0) return;
  sortPins();
  let minLng=180, maxLng=-180, minLat=90, maxLat=-90;
  for(const p of state.pins){
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  if(minLng===maxLng && minLat===maxLat){
    map.easeTo({ center:[minLng,minLat], zoom: 16, duration: 400 });
    return;
  }
  map.fitBounds([[minLng,minLat],[maxLng,maxLat]], { padding, duration: 450 });
}

function highlightPinOnMap(){
  const map = state.map;
  if(!map || !map.getLayer("pins-active")) return;
  const id = state.activePinId || "__none__";
  map.setFilter("pins-active", ["==",["get","id"], id]);
}

function renderMapData(maybeFit=false){
  const map = state.map;
  if(!map || !map.isStyleLoaded()) return;

  // route
  const coords = getPinsLineCoords();
  const route = emptyRoute();
  route.features[0].geometry.coordinates = coords;

  // arrows
  const arrows = { type:"FeatureCollection", features:[] };
  for(const a of computeArrowPoints()){
    arrows.features.push({
      type:"Feature",
      geometry:{ type:"Point", coordinates:[a.lng,a.lat] },
      properties:{ bearing:a.bearing }
    });
  }

  // pins
  const pins = { type:"FeatureCollection", features:[] };
  for(const p of state.pins){
    pins.features.push({
      type:"Feature",
      geometry:{ type:"Point", coordinates:[p.lng,p.lat] },
      properties:{ id:p.id }
    });
  }

  map.getSource("route")?.setData(route);
  map.getSource("arrows")?.setData(arrows);
  map.getSource("pins")?.setData(pins);

  highlightPinOnMap();

  // Photos as HTML markers (thumbnails)
  syncPhotoMarkers();

  if(maybeFit) fitToPins();
  renderStats();
}

function syncPhotoMarkers(){
  const map = state.map;
  if(!map) return;

  // Collect all photos
  const photos = [];
  for(const p of state.pins){
    for(const ph of (p.photos || [])){
      if(typeof ph.lat === "number" && typeof ph.lng === "number"){
        photos.push(ph);
      }else{
        // fallback: pin location
        photos.push({ ...ph, lat:p.lat, lng:p.lng });
      }
    }
  }

  const wanted = new Set(photos.map(p=>p.id));
  // remove old
  for(const [id, marker] of state.photoMarkers.entries()){
    if(!wanted.has(id)){
      marker.remove();
      state.photoMarkers.delete(id);
    }
  }

  // add/update
  for(const ph of photos){
    let marker = state.photoMarkers.get(ph.id);
    if(!marker){
      const el = document.createElement("div");
      el.className = "photo-marker";
      el.style.width = "34px";
      el.style.height = "34px";
      el.style.borderRadius = "10px";
      el.style.overflow = "hidden";
      el.style.border = "2px solid rgba(255,255,255,0.9)";
      el.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
      el.style.background = "rgba(255,255,255,0.15)";
      el.style.backdropFilter = "blur(6px)";
      el.style.display = "grid";
      el.style.placeItems = "center";
      const img = document.createElement("img");
      img.src = ph.thumbDataUrl || ph.dataUrl;
      img.alt = ph.name || "photo";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      el.appendChild(img);

      el.addEventListener("click", (ev)=>{
        ev.stopPropagation();
        // Select nearest pin (the one containing this photo if found)
        for(const pin of state.pins){
          if((pin.photos||[]).some(x=>x.id===ph.id)){
            setActivePin(pin.id);
            break;
          }
        }
      });

      marker = new maplibregl.Marker({ element: el, anchor:"bottom" })
        .setLngLat([ph.lng, ph.lat])
        .addTo(map);
      state.photoMarkers.set(ph.id, marker);
    }else{
      marker.setLngLat([ph.lng, ph.lat]);
      const img = marker.getElement().querySelector("img");
      if(img && img.src !== (ph.thumbDataUrl || ph.dataUrl)) img.src = (ph.thumbDataUrl || ph.dataUrl);
    }
  }
}

async function getCurrentPositionOnce(options){
  return new Promise((resolve,reject)=>{
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function addPinFromPosition(pos, {setActive=true, memo=null} = {}){
  const c = pos.coords;
  const acc = c.accuracy || null;
  const pin = {
    id: uid("pin"),
    lat: c.latitude,
    lng: c.longitude,
    ts: new Date(pos.timestamp || Date.now()).toISOString(),
    acc,
    memo: memo || "",
    photos: [],
  };
  state.pins.push(pin);
  sortPins();
  if(setActive) state.activePinId = pin.id;
  renderMapData(state.pins.length<=2);
  renderTimeline(true);
  renderMemo();
  autoScrollTimelineToActive();
}

async function addPinNow(){
  if(!navigator.geolocation){
    toast("このブラウザは位置情報に対応していません。", 3200);
    return;
  }
  toast("位置情報を取得しています…", 1600);
  try{
    const pos = await getCurrentPositionOnce({
      enableHighAccuracy: true,
      timeout: 9000,
      maximumAge: 1000,
    });
    const acc = pos.coords?.accuracy;
    if(acc && acc > 80){
      toast(`精度が低いかもしれません（誤差 約${Math.round(acc)}m）。必要なら押し直してください。`, 3400);
    }else{
      toast("記録しました。", 1300);
    }
    await addPinFromPosition(pos, { setActive:true });
  }catch(e){
    toast("位置情報の取得に失敗しました。屋外で再試行してください。", 3600);
  }
}

function renderTimeline(keepScroll=false){
  const el = $("#timeline");
  if(!el) return;

  const prevScroll = el.scrollLeft;
  sortPins();

  el.innerHTML = "";
  for(let i=0;i<state.pins.length;i++){
    const p = state.pins[i];
    const card = document.createElement("div");
    card.className = "card" + (p.id===state.activePinId ? " active" : "");
    card.dataset.id = p.id;

    const meta = document.createElement("div");
    meta.className = "meta";
    const left = document.createElement("div");
    left.textContent = `#${i+1}  ${fmtTime(p.ts)}`;
    const right = document.createElement("div");
    right.textContent = p.acc ? `±${Math.round(p.acc)}m` : "";
    meta.appendChild(left);
    meta.appendChild(right);

    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    for(const ph of (p.photos||[]).slice(0,4)){
      const img = document.createElement("img");
      img.src = ph.thumbDataUrl || ph.dataUrl;
      img.alt = ph.name || "photo";
      thumbs.appendChild(img);
    }

    const memo = document.createElement("div");
    memo.className = "memo";
    memo.textContent = (p.memo || "").trim() || "（メモなし）";

    card.appendChild(meta);
    if((p.photos||[]).length>0) card.appendChild(thumbs);
    card.appendChild(memo);

    card.addEventListener("click", ()=> setActivePin(p.id));

    el.appendChild(card);
  }

  if(keepScroll) el.scrollLeft = prevScroll;
}

function autoScrollTimelineToActive(){
  const wrap = $("#timeline");
  if(!wrap) return;
  const card = wrap.querySelector(`.card[data-id="${state.activePinId}"]`);
  if(!card) return;
  const rect = card.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const center = rect.left - wrapRect.left + rect.width/2;
  const target = center - wrapRect.width/2;
  wrap.scrollBy({ left: target, behavior:"smooth" });
}

function renderMemo(){
  const pin = getActivePin();
  const ta = $("#memo");
  if(!ta) return;
  ta.value = pin?.memo || "";
  ta.disabled = !pin;
}

function renderStats(){
  const el = $("#stats");
  if(!el) return;
  const d = routeDistanceKm();
  const n = state.pins.length;
  const auto = state.auto.running ? `自動記録：ON（${Math.round(state.auto.intervalMs/60000)}分）` : "自動記録：OFF";
  el.innerHTML = `
    <div>ピン数：<b>${n}</b></div>
    <div>概算距離：<b>${d.toFixed(2)} km</b></div>
    <div>${auto}</div>
  `;
}

function onMemoChange(){
  const pin = getActivePin();
  if(!pin) return;
  pin.memo = $("#memo").value;
  renderTimeline(true);
}

function clearAll(){
  if(!confirm("全データを消去します。よろしいですか？")) return;
  state.pins = [];
  state.activePinId = null;
  for(const m of state.photoMarkers.values()) m.remove();
  state.photoMarkers.clear();
  renderMapData();
  renderTimeline();
  renderMemo();
  toast("全消去しました。", 1600);
}

async function saveToDevice(){
  const name = prompt("保存名を入力してください（例：富山旅行）", "新しい旅");
  if(!name) return;
  const key = STORAGE_PREFIX + uid("save");
  const payload = { version: 6, name, savedAt: new Date().toISOString(), pins: state.pins };
  await set(key, payload);
  toast("端末に保存しました。", 1600);
  await refreshSavedList();
}

async function refreshSavedList(){
  const sel = $("#savedSelect");
  if(!sel) return;
  const ks = (await keys()).filter(k => typeof k === "string" && k.startsWith(STORAGE_PREFIX));
  sel.innerHTML = `<option value="">保存済みデータ…</option>`;
  for(const k of ks){
    const v = await get(k);
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = `${v?.name || "無名"}（${(v?.pins||[]).length}ピン）`;
    sel.appendChild(opt);
  }
}

async function loadFromDevice(){
  const sel = $("#savedSelect");
  const key = sel?.value;
  if(!key){ toast("読み込むデータを選択してください。", 2200); return; }
  const payload = await get(key);
  if(!payload){ toast("データが見つかりません。", 2200); return; }
  state.pins = payload.pins || [];
  state.activePinId = state.pins[0]?.id || null;
  for(const m of state.photoMarkers.values()) m.remove();
  state.photoMarkers.clear();
  renderTimeline();
  renderMemo();
  renderMapData(true);
  toast("読み込みました。", 1400);
}

async function deleteFromDevice(){
  const sel = $("#savedSelect");
  const key = sel?.value;
  if(!key){ toast("削除するデータを選択してください。", 2200); return; }
  if(!confirm("選択した保存データを削除します。よろしいですか？")) return;
  await del(key);
  toast("削除しました。", 1400);
  await refreshSavedList();
}

function exportJson(){
  const payload = { version: 6, exportedAt: new Date().toISOString(), pins: state.pins };
  const blob = new Blob([JSON.stringify(payload)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `adventure-note-${Date.now()}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1200);
}

async function importJsonFile(file){
  try{
    const text = await file.text();
    const data = JSON.parse(text);
    if(!data || !Array.isArray(data.pins)) throw new Error("bad");
    state.pins = data.pins;
    state.activePinId = state.pins[0]?.id || null;
    for(const m of state.photoMarkers.values()) m.remove();
    state.photoMarkers.clear();
    renderTimeline();
    renderMemo();
    renderMapData(true);
    toast("JSONを読み込みました。", 1600);
  }catch{
    toast("JSONの読み込みに失敗しました。", 3200);
  }
}

async function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = ()=>reject(new Error("read"));
    r.readAsDataURL(file);
  });
}

async function resizeImageToDataUrl(file, maxEdge, quality=0.8){
  const dataUrl = await fileToDataUrl(file);
  const img = await new Promise((resolve,reject)=>{
    const i = new Image();
    i.onload = ()=>resolve(i);
    i.onerror = ()=>reject(new Error("img"));
    i.src = dataUrl;
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w,h));
  const cw = Math.round(w*scale), ch = Math.round(h*scale);
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, cw, ch);
  return canvas.toDataURL("image/jpeg", quality);
}

function nearestPinByTime(tsIso){
  const t = new Date(tsIso).getTime();
  let best = null, bestDt = Infinity;
  for(const p of state.pins){
    const dt = Math.abs(new Date(p.ts).getTime() - t);
    if(dt < bestDt){
      bestDt = dt; best = p;
    }
  }
  return { pin: best, dtMs: bestDt };
}

async function importPhotos(files){
  const list = Array.from(files || []);
  if(list.length === 0) return;
  toast(`写真を処理中…（${list.length}枚）`, 2000);

  for(const file of list){
    let exifTimeIso = null;
    let exifLat = null, exifLng = null;

    try{
      const data = await exifr.parse(file, { tiff:true, exif:true, ifd0:true, gps:true });
      const dt = data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate;
      if(dt instanceof Date) exifTimeIso = dt.toISOString();

      // exifr returns latitude/longitude when gps:true (typical)
      if(typeof data?.latitude === "number" && typeof data?.longitude === "number"){
        exifLat = data.latitude;
        exifLng = data.longitude;
      }
    }catch(e){
      // ignore
    }

    if(!exifTimeIso){
      exifTimeIso = new Date(file.lastModified || Date.now()).toISOString();
    }

    const dataUrl = await resizeImageToDataUrl(file, MAX_PHOTO_EDGE, PHOTO_JPEG_QUALITY);
    const thumbDataUrl = await resizeImageToDataUrl(file, THUMB_EDGE, 0.78);

    const photo = {
      id: uid("ph"),
      ts: exifTimeIso,
      name: file.name,
      dataUrl,
      thumbDataUrl,
      lat: exifLat,
      lng: exifLng
    };

    // Decide target pin:
    if(state.pins.length === 0){
      if(exifLat != null && exifLng != null){
        // create pin from photo location
        const pin = { id: uid("pin"), lat: exifLat, lng: exifLng, ts: exifTimeIso, acc:null, memo:"", photos:[photo] };
        state.pins.push(pin);
        state.activePinId = pin.id;
      }else{
        // can't place
        toast("位置情報のない写真は、先にピンを作ってから読み込んでください。", 2600);
      }
      continue;
    }

    const { pin, dtMs } = nearestPinByTime(exifTimeIso);

    if(pin && dtMs <= ATTACH_TIME_WINDOW_MS){
      // attach to nearest pin by time
      if(exifLat != null && exifLng != null){
        // if photo has its own location, keep it (marker will be at photo location)
      }else{
        // inherit pin location for marker
        photo.lat = pin.lat;
        photo.lng = pin.lng;
      }
      pin.photos = pin.photos || [];
      pin.photos.push(photo);
    }else{
      // If GPS exists, create a new pin at photo location/time
      if(exifLat != null && exifLng != null){
        const newPin = { id: uid("pin"), lat: exifLat, lng: exifLng, ts: exifTimeIso, acc:null, memo:"", photos:[photo] };
        state.pins.push(newPin);
      }else if(pin){
        // fallback attach even if far (better than losing)
        photo.lat = pin.lat; photo.lng = pin.lng;
        pin.photos.push(photo);
      }
    }
  }

  sortPins();
  if(!state.activePinId && state.pins[0]) state.activePinId = state.pins[0].id;

  renderTimeline();
  renderMemo();
  renderMapData(true);
  toast("写真を配置しました。", 1600);
}

function startAuto(){
  if(state.auto.running){
    stopAuto();
    return;
  }
  if(!navigator.geolocation){
    toast("このブラウザは位置情報に対応していません。", 3200);
    return;
  }
  state.auto.intervalMs = Number($("#autoInterval").value) || 180000;
  state.auto.running = true;
  $("#btnAuto").textContent = "自動記録：停止";
  toast("自動記録を開始しました。", 1400);

  const tick = async ()=>{
    try{
      const pos = await getCurrentPositionOnce({
        enableHighAccuracy: false, // battery friendly
        timeout: 9000,
        maximumAge: 10000,
      });
      await addPinFromPosition(pos, { setActive:false });
      // keep active pin as last manual selection; but highlight last recorded if none selected
      if(!state.activePinId) state.activePinId = state.pins[state.pins.length-1]?.id || null;
      renderMapData(false);
      renderTimeline(true);
      renderStats();
    }catch(e){
      toast("自動記録：位置情報の取得に失敗しました。", 2200);
    }
  };

  // first tick immediately
  tick();
  state.auto.timer = setInterval(tick, state.auto.intervalMs);
  renderStats();
}

function stopAuto(){
  state.auto.running = false;
  $("#btnAuto").textContent = "自動記録：開始";
  if(state.auto.timer){
    clearInterval(state.auto.timer);
    state.auto.timer = null;
  }
  toast("自動記録を停止しました。", 1400);
  renderStats();
}

function wireUi(){
  $("#btnPin").addEventListener("click", addPinNow);
  $("#btnClear").addEventListener("click", clearAll);

  $("#memo").addEventListener("input", onMemoChange);

  $("#filePhotos").addEventListener("change", (e)=>{
    importPhotos(e.target.files);
    e.target.value = "";
  });

  $("#btnSave").addEventListener("click", saveToDevice);
  $("#btnLoad").addEventListener("click", loadFromDevice);
  $("#btnDelete").addEventListener("click", deleteFromDevice);

  $("#btnExport").addEventListener("click", exportJson);
  $("#fileImportJson").addEventListener("change", async (e)=>{
    const f = e.target.files?.[0];
    if(f) await importJsonFile(f);
    e.target.value = "";
  });

  $("#btnAuto").addEventListener("click", startAuto);
  $("#autoInterval").addEventListener("change", ()=>{
    if(state.auto.running){
      // restart with new interval
      stopAuto();
      startAuto();
    }
  });
}

async function boot(){
  wireUi();
  await initMap();
  await refreshSavedList();
  renderTimeline();
  renderMemo();
  renderStats();
}

boot();
