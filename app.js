/* Adventure Note（平面地図版）
   - 📍ピンを時系列で追加し、軌跡（蛍光イエロー）と方向矢印（三角）を表示
   - 写真を後から読み込み、EXIFの撮影時刻/位置情報でピンに自動配置・紐づけ
   - JSONの書き出し/読み込み
   - 自動記録（1/3/5分）※iOS Webは前面動作前提
*/

const STORAGE_KEY = "adventure_note_v1";

// 状態
const state = {
  pins: [], // {id, lat, lng, timestamp, accuracyM, note, photos:[{id, filename, takenAt, gps?, thumbDataUrl}]}
  auto: { running: false, timerId: null, intervalSec: 180 },
  ui: { activePinId: null },
};

// DOM
const el = {
  recordBtn: document.getElementById("recordBtn"),
  autoToggleBtn: document.getElementById("autoToggleBtn"),
  autoIntervalSel: document.getElementById("autoIntervalSel"),
  photoInput: document.getElementById("photoInput"),
  timeline: document.getElementById("timeline"),
  timelineMeta: document.getElementById("timelineMeta"),
  toast: document.getElementById("toast"),
  menuBtn: document.getElementById("menuBtn"),
  menuPanel: document.getElementById("menuPanel"),
  menuCloseBtn: document.getElementById("menuCloseBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  importJsonInput: document.getElementById("importJsonInput"),
  clearBtn: document.getElementById("clearBtn"),
};

// ---------- 汎用 ----------
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch { return ""; }
}

function showToast(msg, ms=1800) {
  el.toast.textContent = msg;
  el.toast.classList.remove("hidden");
  setTimeout(() => el.toast.classList.add("hidden"), ms);
}

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), pins: state.pins }));
  } catch (e) {
    console.warn(e);
  }
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.pins)) state.pins = obj.pins;
  } catch (e) {
    console.warn(e);
  }
}

// 距離（m）
function distM(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function calcBearing(lat1, lng1, lat2, lng2) {
  const toRad = (x) => x * Math.PI / 180;
  const toDeg = (x) => x * 180 / Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  let θ = Math.atan2(y, x);
  θ = (toDeg(θ) + 360) % 360;
  return θ;
}

function findNearestPinByTime(takenAtMs) {
  if (state.pins.length === 0) return null;
  let best = null;
  let bestDt = Infinity;
  for (const p of state.pins) {
    const dt = Math.abs(new Date(p.timestamp).getTime() - takenAtMs);
    if (dt < bestDt) { bestDt = dt; best = p; }
  }
  return { pin: best, dtMs: bestDt };
}
function findNearestPinByTimeWithin(takenAtMs, withinMs) {
  const r = findNearestPinByTime(takenAtMs);
  if (!r) return null;
  return r.dtMs <= withinMs ? r.pin : null;
}

// ---------- EXIF補助 ----------
function rationalToFloat(r) {
  if (typeof r === "number") return r;
  if (!r) return NaN;
  if (typeof r.numerator === "number" && typeof r.denominator === "number") {
    return r.denominator ? (r.numerator / r.denominator) : NaN;
  }
  return NaN;
}
function dmsToDeg(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return NaN;
  const d = rationalToFloat(dms[0]);
  const m = rationalToFloat(dms[1]);
  const s = rationalToFloat(dms[2]);
  let deg = d + (m/60) + (s/3600);
  if (ref === "S" || ref === "W") deg *= -1;
  return deg;
}
function parseExifDate(str) {
  // "YYYY:MM:DD HH:MM:SS"
  if (!str || typeof str !== "string") return null;
  const m = str.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [_, y, mo, d, hh, mm, ss] = m;
  return new Date(Number(y), Number(mo)-1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
}

async function fileToDataURL(file, maxW=720, quality=0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const scale = Math.min(1, maxW / img.width);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 地図 ----------
/* 重要：
   OpenFreeMapのstyleは `https://tiles.openfreemap.org/styles/liberty` が動作します。
*/
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [137.2, 36.7], // 富山付近の初期値（任意）
  zoom: 12.5,
  pitch: 0,
  bearing: 0,
  attributionControl: true
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), "top-right");

const SOURCES = { pins: "pins-src", route: "route-src", arrows: "arrows-src" };

function pinsToGeoJSON() {
  return {
    type: "FeatureCollection",
    features: state.pins.map((p, idx) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: { id: p.id, idx: idx + 1, label: "📍" }
    }))
  };
}
function routeToGeoJSON() {
  const coords = state.pins.map(p => [p.lng, p.lat]);
  return {
    type: "FeatureCollection",
    features: coords.length >= 2 ? [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {}
    }] : []
  };
}
function computeArrowPoints() {
  const coords = state.pins.map(p => ({ lng: p.lng, lat: p.lat }));
  const features = [];
  if (coords.length < 2) return { type: "FeatureCollection", features };

  const segs = [];
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i+1];
    const len = distM(a, b);
    segs.push({ a, b, len });
    total += len;
  }

  // 全長に応じて矢印数を決める（最低2、最大12）
  const desired = clamp(Math.round(total / 400), 2, 12);
  const spacing = total / (desired + 1);

  let target = spacing;
  let acc = 0;
  let segIndex = 0;

  while (segIndex < segs.length && target < total) {
    const seg = segs[segIndex];
    if (acc + seg.len >= target) {
      const t = (target - acc) / seg.len;
      const lng = seg.a.lng + (seg.b.lng - seg.a.lng) * t;
      const lat = seg.a.lat + (seg.b.lat - seg.a.lat) * t;
      const bearing = calcBearing(seg.a.lat, seg.a.lng, seg.b.lat, seg.b.lng);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { bearing }
      });
      target += spacing;
    } else {
      acc += seg.len;
      segIndex++;
    }
  }
  return { type: "FeatureCollection", features };
}

function ensureTriangleIcon() {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // 上向きの三角（回転は icon-rotate で）
  ctx.clearRect(0,0,size,size);
  ctx.beginPath();
  ctx.moveTo(size/2, 6);
  ctx.lineTo(size-10, size-10);
  ctx.lineTo(10, size-10);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,0,0.95)";
  ctx.shadowColor = "rgba(255,255,0,0.9)";
  ctx.shadowBlur = 10;
  ctx.fill();

  const imgData = ctx.getImageData(0, 0, size, size);
  if (!map.hasImage("dir-tri")) {
    map.addImage("dir-tri", { width: size, height: size, data: imgData.data });
  }
}

let photoMarkers = [];
function clearPhotoMarkers() {
  for (const m of photoMarkers) m.remove();
  photoMarkers = [];
}
function renderPhotoMarkers() {
  clearPhotoMarkers();
  for (const pin of state.pins) {
    if (!pin.photos || pin.photos.length === 0) continue;
    const first = pin.photos[0];
    if (!first.thumbDataUrl) continue;

    const wrap = document.createElement("div");
    wrap.style.width = "42px";
    wrap.style.height = "42px";
    wrap.style.borderRadius = "12px";
    wrap.style.overflow = "hidden";
    wrap.style.border = "2px solid rgba(255,255,255,0.9)";
    wrap.style.boxShadow = "0 8px 18px rgba(0,0,0,0.35)";

    const img = document.createElement("img");
    img.src = first.thumbDataUrl;
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    wrap.appendChild(img);

    const m = new maplibregl.Marker({ element: wrap, anchor: "bottom" })
      .setLngLat([pin.lng, pin.lat])
      .addTo(map);

    photoMarkers.push(m);
  }
}

function refreshMapData() {
  if (!map.isStyleLoaded()) return;

  const pinsSrc = map.getSource(SOURCES.pins);
  const routeSrc = map.getSource(SOURCES.route);
  const arrowsSrc = map.getSource(SOURCES.arrows);

  const pinsG = pinsToGeoJSON();
  const routeG = routeToGeoJSON();
  const arrowsG = computeArrowPoints();

  if (pinsSrc) pinsSrc.setData(pinsG);
  if (routeSrc) routeSrc.setData(routeG);
  if (arrowsSrc) arrowsSrc.setData(arrowsG);

  renderPhotoMarkers();
  el.timelineMeta.textContent = `${state.pins.length}件`;
}

function fitToPins() {
  if (state.pins.length === 0) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const p of state.pins) bounds.extend([p.lng, p.lat]);
  map.fitBounds(bounds, { padding: 70, duration: 600 });
}

// ---------- タイムライン ----------
function renderTimeline() {
  el.timeline.innerHTML = "";
  const frag = document.createDocumentFragment();

  state.pins.forEach((p, idx) => {
    const card = document.createElement("div");
    card.className = "card" + (p.id === state.ui.activePinId ? " active" : "");

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = `${idx+1}. ${fmtTime(p.timestamp)}`;

    const s = document.createElement("div");
    s.className = "s";
    const photoCount = (p.photos?.length || 0);
    s.textContent = `${photoCount ? "📷 " + photoCount + "枚 / " : ""}${(p.accuracyM!=null ? "±" + Math.round(p.accuracyM) + "m" : "")}`.trim();

    card.appendChild(t);
    card.appendChild(s);

    if (photoCount && p.photos[0].thumbDataUrl) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = p.photos[0].thumbDataUrl;
      img.alt = "写真";
      card.appendChild(img);
    }

    card.onclick = () => {
      state.ui.activePinId = p.id;
      renderTimeline();
      map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 14), duration: 450 });
    };

    frag.appendChild(card);
  });

  el.timeline.appendChild(frag);

  // “今どこ”：最新へ自動スクロール
  if (state.pins.length > 0) {
    requestAnimationFrame(() => { el.timeline.scrollLeft = el.timeline.scrollWidth; });
  }
}

// ---------- ピン追加/位置取得 ----------
async function addPin({ lat, lng, timestamp = new Date().toISOString(), accuracyM = null }) {
  const pin = { id: uuid(), lat, lng, timestamp, accuracyM, note: "", photos: [] };
  state.pins.push(pin);
  state.ui.activePinId = pin.id;

  refreshMapData();
  renderTimeline();
  saveLocal();

  if (state.pins.length === 1) map.easeTo({ center: [lng, lat], zoom: 15, duration: 450 });
}

function geolocateOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("位置情報が利用できません。"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

el.recordBtn.addEventListener("click", async () => {
  try {
    showToast("位置情報を取得中…");
    const pos = await geolocateOnce();
    const { latitude, longitude, accuracy } = pos.coords;
    await addPin({ lat: latitude, lng: longitude, timestamp: new Date().toISOString(), accuracyM: accuracy });

    if (accuracy != null && accuracy > 60) {
      showToast(`精度が低めです（±${Math.round(accuracy)}m）。屋外で少し待って押し直すと改善することがあります。`, 2600);
    } else {
      showToast("記録しました");
    }
  } catch (e) {
    console.warn(e);
    showToast("位置情報を取得できませんでした（HTTPS/許可設定を確認）", 2600);
  }
});

// ---------- 自動記録 ----------
el.autoIntervalSel.addEventListener("change", () => {
  state.auto.intervalSec = Number(el.autoIntervalSel.value || "180");
  if (state.auto.running) {
    stopAuto();
    startAuto();
  } else {
    el.autoToggleBtn.textContent = `▶ 自動記録（${state.auto.intervalSec/60}分）`;
  }
});

function startAuto() {
  const intervalMs = state.auto.intervalSec * 1000;
  state.auto.running = true;

  el.autoToggleBtn.textContent = "■ 自動記録停止";
  el.autoToggleBtn.classList.remove("secondary");
  el.autoToggleBtn.classList.add("primary");

  state.auto.timerId = setInterval(async () => {
    try {
      const pos = await geolocateOnce();
      const { latitude, longitude, accuracy } = pos.coords;
      await addPin({ lat: latitude, lng: longitude, timestamp: new Date().toISOString(), accuracyM: accuracy });
      showToast("自動記録：追加しました");
    } catch {
      showToast("自動記録：位置情報を取得できませんでした", 2000);
    }
  }, intervalMs);

  showToast(`自動記録を開始しました（${state.auto.intervalSec/60}分間隔）`, 2200);
}

function stopAuto() {
  if (state.auto.timerId) clearInterval(state.auto.timerId);
  state.auto.timerId = null;
  state.auto.running = false;

  el.autoToggleBtn.textContent = `▶ 自動記録（${state.auto.intervalSec/60}分）`;
  el.autoToggleBtn.classList.add("secondary");
  el.autoToggleBtn.classList.remove("primary");

  showToast("自動記録を停止しました");
}

el.autoToggleBtn.addEventListener("click", () => {
  if (state.auto.running) stopAuto();
  else startAuto();
});

// ---------- 写真取り込み（自動配置） ----------
async function attachPhotoToPin(pin, photo) {
  pin.photos = pin.photos || [];
  pin.photos.push(photo);
}

async function handlePhotoFiles(files) {
  if (!files || files.length === 0) return;
  showToast("写真を解析中…");

  for (const file of files) {
    const photoId = uuid();
    const filename = file.name || "photo.jpg";

    // サムネ作成
    let thumbDataUrl = null;
    try { thumbDataUrl = await fileToDataURL(file, 720, 0.82); } catch (e) { console.warn("thumb error", e); }

    // EXIF抽出
    const exif = await new Promise((resolve) => {
      EXIF.getData(file, function () {
        const dtStr = EXIF.getTag(this, "DateTimeOriginal") || EXIF.getTag(this, "DateTime") || null;
        const takenAtMs = parseExifDate(dtStr);

        const gpsLat = EXIF.getTag(this, "GPSLatitude");
        const gpsLatRef = EXIF.getTag(this, "GPSLatitudeRef");
        const gpsLng = EXIF.getTag(this, "GPSLongitude");
        const gpsLngRef = EXIF.getTag(this, "GPSLongitudeRef");

        let lat = NaN, lng = NaN;
        if (gpsLat && gpsLng) {
          lat = dmsToDeg(gpsLat, gpsLatRef);
          lng = dmsToDeg(gpsLng, gpsLngRef);
        }

        resolve({ takenAtMs, gps: (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null });
      });
    });

    const photo = {
      id: photoId,
      filename,
      takenAt: exif.takenAtMs ? new Date(exif.takenAtMs).toISOString() : null,
      gps: exif.gps,
      thumbDataUrl
    };

    // 自動配置ルール
    const withinMs = 10 * 60 * 1000;

    if (photo.gps) {
      let targetPin = null;

      if (exif.takenAtMs != null) {
        targetPin = findNearestPinByTimeWithin(exif.takenAtMs, withinMs);
      }

      if (!targetPin) {
        const ts = (exif.takenAtMs != null) ? new Date(exif.takenAtMs).toISOString() : new Date().toISOString();
        await addPin({ lat: photo.gps.lat, lng: photo.gps.lng, timestamp: ts, accuracyM: null });
        targetPin = state.pins[state.pins.length - 1];
      }

      await attachPhotoToPin(targetPin, photo);

    } else if (exif.takenAtMs != null) {
      const nearest = findNearestPinByTime(exif.takenAtMs);
      if (nearest && nearest.pin) {
        await attachPhotoToPin(nearest.pin, photo);
      } else {
        console.warn("ピンがないため写真を紐づけできません:", filename);
      }
    } else {
      console.warn("EXIFの時刻/GPSが無いため自動配置できません:", filename);
    }
  }

  refreshMapData();
  renderTimeline();
  saveLocal();
  showToast("写真の自動配置が完了しました");
}

el.photoInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  el.photoInput.value = ""; // 同じ写真を再選択できるように
  await handlePhotoFiles(files);
});

// ---------- JSON入出力 ----------
function downloadBlob(filename, contentType, dataStr) {
  const blob = new Blob([dataStr], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

el.exportJsonBtn.addEventListener("click", () => {
  const payload = { version: 1, exportedAt: new Date().toISOString(), pins: state.pins };
  const name = `adventure_note_${new Date().toISOString().slice(0,10)}.json`;
  downloadBlob(name, "application/json", JSON.stringify(payload, null, 2));
  showToast("JSONを書き出しました");
});

el.importJsonInput.addEventListener("change", async (e) => {
  const file = (e.target.files || [])[0];
  el.importJsonInput.value = "";
  if (!file) return;

  try {
    const txt = await file.text();
    const obj = JSON.parse(txt);
    if (!obj || !Array.isArray(obj.pins)) throw new Error("invalid");

    state.pins = obj.pins;
    state.ui.activePinId = state.pins.length ? state.pins[state.pins.length - 1].id : null;

    refreshMapData();
    renderTimeline();
    saveLocal();
    fitToPins();
    showToast("JSONを読み込みました");
  } catch (e2) {
    console.warn(e2);
    showToast("JSONの読み込みに失敗しました", 2200);
  }
});

// ---------- メニュー ----------
function openMenu() { el.menuPanel.classList.remove("hidden"); }
function closeMenu() { el.menuPanel.classList.add("hidden"); }
el.menuBtn.addEventListener("click", openMenu);
el.menuCloseBtn.addEventListener("click", closeMenu);
el.menuPanel.addEventListener("click", (ev) => { if (ev.target === el.menuPanel) closeMenu(); });

// 消去
el.clearBtn.addEventListener("click", () => {
  if (!confirm("この端末内のデータをすべて消去します。よろしいですか？")) return;
  state.pins = [];
  state.ui.activePinId = null;
  saveLocal();
  refreshMapData();
  renderTimeline();
  showToast("消去しました");
});

// ---------- 初期化 ----------
loadLocal();

map.on("load", () => {
  map.addSource(SOURCES.pins, { type: "geojson", data: pinsToGeoJSON() });
  map.addSource(SOURCES.route, { type: "geojson", data: routeToGeoJSON() });
  map.addSource(SOURCES.arrows, { type: "geojson", data: computeArrowPoints() });

  // 軌跡：蛍光イエロー（グロー下敷き → 本線）
  map.addLayer({
    id: "route-glow",
    type: "line",
    source: SOURCES.route,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": "rgba(255,255,0,0.35)",
      "line-width": 14,
      "line-blur": 6
    }
  });

  map.addLayer({
    id: "route-line",
    type: "line",
    source: SOURCES.route,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": "rgba(255,255,0,0.95)",
      "line-width": 7,
      "line-blur": 0.6
    }
  });

  // ピン：📍
  map.addLayer({
    id: "pins",
    type: "symbol",
    source: SOURCES.pins,
    layout: {
      "text-field": ["get", "label"],
      "text-size": 24,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
      "text-anchor": "bottom",
      "text-offset": [0, -0.2]
    }
  });

  // 方向矢印（三角）
  ensureTriangleIcon();
  map.addLayer({
    id: "arrows",
    type: "symbol",
    source: SOURCES.arrows,
    layout: {
      "icon-image": "dir-tri",
      "icon-size": 0.45,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-anchor": "center"
    }
  });

  refreshMapData();
  renderTimeline();
  if (state.pins.length) fitToPins();
});
