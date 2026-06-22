"use strict";

// ----- Config (defaults from static/config.js; user-editable) -----
const CONFIG = window.RADAR_CONFIG || {};
const FETCH_INTERVAL_MS = CONFIG.FETCH_INTERVAL_MS ?? 2000;
const RING_COUNT = CONFIG.RING_COUNT ?? 4;
const SWEEP_SPEED = CONFIG.SWEEP_SPEED ?? 2.0; // radians / second
const NEARBY_FRACTION = CONFIG.NEARBY_FRACTION ?? 1 / 3;
const DEFAULT_CENTER = {
  lat: CONFIG.DEFAULT_LAT ?? 42.6967,
  lon: CONFIG.DEFAULT_LON ?? 23.4114,
};
const DEFAULT_RADIUS = CONFIG.DEFAULT_RADIUS_KM ?? 25;

const TAU = Math.PI * 2;
const FADE_SECONDS = TAU / SWEEP_SPEED;
const COLORS = {
  arriving: "#00ff66",
  departing: "#ffb300",
  cruising: "#2b6cff",
};

// Card notification visible for 2 minutes after shown.
const CARD_NOTICE_MS = 2 * 60 * 1000;

// A grounded (0 m) aircraft stays visible only this long after it lands.
const LANDED_GRACE_MS = 2 * 60 * 1000;

// A changed classification must hold this long before the displayed status
// switches — filters out brief altitude blips (e.g. a flare while landing).
const CLASS_STABLE_MS = 5 * 1000;

// ----- Geo helpers (mirror app/utils/geo.py) -----
const R_EARTH_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const x = Math.sin(dLambda) * Math.cos(phi2);
  const y =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(x, y) * 180) / Math.PI;
}

// ----- DOM -----
const canvas = document.getElementById("ppi");
const ctx = canvas.getContext("2d");
const form = document.getElementById("controls");
const statusEl = document.getElementById("status-line");
const cardsEl = document.getElementById("cards");
const dataStatusEl = document.getElementById("data-status");
const dataStatusMsg = document.getElementById("data-status-msg");
const mockToggle = document.getElementById("mock-toggle");
const mockLabel = document.getElementById("mock-label");
const soundToggle = document.getElementById("sound-toggle");
const soundLabel = document.getElementById("sound-label");
const latInput = document.getElementById("lat");
const lonInput = document.getElementById("lon");
const radiusInput = document.getElementById("radius");

// ----- State -----
const state = {
  center: { ...DEFAULT_CENTER },
  radius: DEFAULT_RADIUS,
};

let mockMode = localStorage.getItem("mockMode") === "true";
// Sound notifications are on by default; sticky user preference.
let soundEnabled = localStorage.getItem("soundEnabled") !== "false";

// `incoming`: freshest fetched data buffered until the sweep crosses each blip.
// `rendered`: what is actually on screen, with per-blip intensity.
const incoming = new Map(); // icao24 -> aircraft
const rendered = new Map(); // icao24 -> { ...aircraft, intensity }
let lastList = [];

const photoCache = new Map(); // key -> url | null
const blipPositions = new Map(); // icao24 -> {x, y} CSS pixels, for click detection
const lastSeen = new Set(); // icao24s present on the radar in the previous poll
// Every aircraft that triggered an audio alert, mapped to the timestamp its
// breathing should stop. Each ding adds an entry, so every alert has a matching
// flashing card for CARD_NOTICE_MS.
const notified = new Map(); // icao24 -> deadline (ms epoch)
// icao24 whose card should be scrolled into view on the next render.
let pendingScrollIcao = null;
const prevGround = new Map(); // icao24 -> boolean: was on-ground last poll
const landedAt = new Map(); // icao24 -> timestamp it transitioned airborne -> ground
// Classification smoothing: the displayed status only changes once a new
// classification has held for CLASS_STABLE_MS, so a brief altitude blip while
// landing isn't shown as "taking off".
const shownClass = new Map(); // icao24 -> currently displayed classification
const pendingClass = new Map(); // icao24 -> { cls, since } awaiting confirmation

let selectedIcao = null; // null = no filter; set = show only this on radar

let size = 0;
let sweepAngle = 0;
let lastFrame = performance.now();

let intervalId = null;
let fetchInFlight = false;
let requestSeq = 0;

// Lazy AudioContext — created on first alert (browser autoplay policy).
let audioCtx = null;

const normAngle = (a) => ((a % TAU) + TAU) % TAU;

function sweepCrossed(prev, cur, t) {
  prev = normAngle(prev);
  cur = normAngle(cur);
  t = normAngle(t);
  return prev <= cur ? t > prev && t <= cur : t > prev || t <= cur;
}

// ----- Canvas sizing (crisp on HiDPI) -----
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  size = rect.width;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ----- Inputs / persistence (localStorage) -----
function readInputs() {
  return {
    lat: parseFloat(latInput.value),
    lon: parseFloat(lonInput.value),
    radius: parseFloat(radiusInput.value),
  };
}

function loadParams() {
  const lat = localStorage.getItem("lat");
  const lon = localStorage.getItem("lon");
  const radius = localStorage.getItem("radius");
  latInput.value = lat !== null ? lat : DEFAULT_CENTER.lat;
  lonInput.value = lon !== null ? lon : DEFAULT_CENTER.lon;
  radiusInput.value = radius !== null ? radius : DEFAULT_RADIUS;
}

function persistParams() {
  const { lat, lon, radius } = readInputs();
  if (!Number.isNaN(lat)) localStorage.setItem("lat", String(lat));
  if (!Number.isNaN(lon)) localStorage.setItem("lon", String(lon));
  if (!Number.isNaN(radius)) localStorage.setItem("radius", String(radius));
}

function updateMockButton() {
  mockToggle.classList.toggle("mock-on", mockMode);
  mockToggle.setAttribute("aria-checked", String(mockMode));
  mockLabel.textContent = mockMode ? "MOCK" : "LIVE";
}

function updateSoundButton() {
  soundToggle.classList.toggle("sound-on", soundEnabled);
  soundToggle.setAttribute("aria-checked", String(soundEnabled));
  soundLabel.textContent = soundEnabled ? "NOTIFICATION ON" : "NOTIFICATION OFF";
}

// ----- Data-link warning light -----
function setWarning(on, msg = "") {
  dataStatusEl.classList.toggle("alert", on);
  dataStatusMsg.textContent = on ? msg : "";
}

// ----- Audio alerts -----
function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// Browsers start an AudioContext suspended until the user interacts with the
// page. Resume it on the first gesture (anywhere) so later alerts can play.
function unlockAudio() {
  try {
    getAudioCtx().resume?.();
  } catch (e) {
    /* audio not available */
  }
  window.removeEventListener("pointerdown", unlockAudio);
  window.removeEventListener("keydown", unlockAudio);
}
window.addEventListener("pointerdown", unlockAudio);
window.addEventListener("keydown", unlockAudio);

function playDing(ac, freq, delay) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = "sine";
  osc.frequency.value = freq;
  const t = ac.currentTime + delay;
  gain.gain.setValueAtTime(0.4, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
  osc.start(t);
  osc.stop(t + 0.8);
}

// Ding-ding, then the same pair repeated 2 seconds later.
function playAlert() {
  if (!soundEnabled) return;
  try {
    const ac = getAudioCtx();
    playDing(ac, 880, 0);
    playDing(ac, 1100, 0.35);
    playDing(ac, 880, 2.35);
    playDing(ac, 1100, 2.70);
  } catch (e) {
    /* audio not available */
  }
}

// ----- Classification smoothing -----
// Resist brief flips: a new classification only takes effect once it has held
// for CLASS_STABLE_MS. Brand-new contacts adopt their classification at once.
function smoothClass(icao, raw, now) {
  const shown = shownClass.get(icao);
  if (shown === undefined) {
    shownClass.set(icao, raw);
    pendingClass.delete(icao);
    return raw;
  }
  if (raw === shown) {
    pendingClass.delete(icao); // back to the stable state
    return shown;
  }
  const pending = pendingClass.get(icao);
  if (pending && pending.cls === raw) {
    if (now - pending.since >= CLASS_STABLE_MS) {
      shownClass.set(icao, raw);
      pendingClass.delete(icao);
      return raw;
    }
  } else {
    pendingClass.set(icao, { cls: raw, since: now });
  }
  return shown; // keep the stable status until the change is confirmed
}

// ----- New-aircraft detection (sound + breathing card) -----
// Ding whenever an arriving/departing aircraft that wasn't present in the
// previous poll shows up — mock or live, foreground or background. If several
// appear at once the farthest one wins (it just crossed into the scope); its
// card breathes and scrolls into view so the sound has a clear visual anchor.
function detectNewAircraft(list, now) {
  let newestAc = null;
  let newestDist = -1;
  const present = new Set();
  for (const ac of list) {
    present.add(ac.icao24);
    const isNew = !lastSeen.has(ac.icao24);
    if (
      isNew &&
      !ac._landed &&
      (ac.classification === "arriving" || ac.classification === "departing") &&
      ac._dist > newestDist
    ) {
      newestAc = ac;
      newestDist = ac._dist;
    }
  }
  // Remember exactly who is present now, for the next poll's comparison.
  lastSeen.clear();
  for (const id of present) lastSeen.add(id);

  if (newestAc !== null) {
    notified.set(newestAc.icao24, now + CARD_NOTICE_MS);
    pendingScrollIcao = newestAc.icao24;
    playAlert();
  }
}


// ----- Data loop -----
async function fetchData() {
  const { lat, lon, radius } = readInputs();
  if (Number.isNaN(lat) || Number.isNaN(lon) || Number.isNaN(radius)) return;

  const myReq = ++requestSeq;
  const params = new URLSearchParams({
    lat,
    lon,
    radius_km: radius,
    mock: mockMode ? "true" : "false",
  });

  try {
    const resp = await fetch(`/aircraft?${params.toString()}`);
    if (!resp.ok) {
      setWarning(true, "SERVER ERROR");
      return;
    }
    const data = await resp.json();

    if (myReq !== requestSeq) return;

    state.center = data.center;
    state.radius = data.radius_km;

    const now = Date.now();
    const enriched = data.aircraft.map((ac) => {
      const dist = haversineKm(
        data.center.lat,
        data.center.lon,
        ac.latitude,
        ac.longitude,
      );
      const brg = bearingDeg(
        data.center.lat,
        data.center.lon,
        ac.latitude,
        ac.longitude,
      );
      const cls = smoothClass(ac.icao24, ac.classification, now);
      return {
        ...ac,
        classification: cls,
        _dist: dist,
        _bearing: brg,
        _frac: dist / data.radius_km,
      };
    });

    // Track landings: an aircraft we previously saw airborne and now see at 0 m
    // just landed. Keep only currently-present aircraft in the tracking maps so
    // a craft that disappears and reappears at 0 m isn't mistaken for a landing.
    const present = new Set();
    for (const ac of enriched) {
      present.add(ac.icao24);
      const onGround = ac.altitude_m <= 0 || ac.classification === "ground";
      if (onGround) {
        if (prevGround.get(ac.icao24) === false) landedAt.set(ac.icao24, now);
      } else {
        landedAt.delete(ac.icao24); // airborne again (or still flying)
      }
      prevGround.set(ac.icao24, onGround);
    }
    for (const id of prevGround.keys()) if (!present.has(id)) prevGround.delete(id);
    for (const id of landedAt.keys()) if (!present.has(id)) landedAt.delete(id);
    for (const id of shownClass.keys()) if (!present.has(id)) shownClass.delete(id);
    for (const id of pendingClass.keys()) if (!present.has(id)) pendingClass.delete(id);

    // Show airborne aircraft, plus grounded ones only within the landing grace.
    // "Ground" means alt_m == 0 (ADS-B literal) OR backend classified as "ground"
    // (barometric altitude within 50 m of airport elevation). Grounded-and-kept
    // aircraft are tagged `_landed` for styling/sorting.
    const list = [];
    for (const ac of enriched) {
      const onGround = ac.altitude_m <= 0 || ac.classification === "ground";
      if (!onGround) {
        list.push(ac);
      } else {
        const t = landedAt.get(ac.icao24);
        if (t !== undefined && now - t < LANDED_GRACE_MS) {
          list.push({ ...ac, _landed: true });
        }
      }
    }

    incoming.clear();
    for (const ac of list) incoming.set(ac.icao24, ac);

    lastList = list;
    statusEl.textContent =
      `${list.length} aircraft · ` +
      `${data.mock ? "MOCK" : "LIVE"} · updated ${new Date().toLocaleTimeString()}`;

    detectNewAircraft(list, now);
    renderCards();

    setWarning(list.length === 0, "NO DATA");
  } catch (err) {
    setWarning(true, "NO CONNECTION");
  }
}

async function runFetch() {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    await fetchData();
  } finally {
    fetchInFlight = false;
  }
}

function startPolling() {
  clearInterval(intervalId);
  intervalId = setInterval(runFetch, FETCH_INTERVAL_MS);
}

function triggerUpdate() {
  persistParams();
  requestSeq++;
  clearInterval(intervalId);
  runFetch();
  startPolling();
}

// ----- Aircraft photos (planespotters), cached per registration/hex -----
function photoKey(ac) {
  return ac.registration || ac.icao24 || "";
}

async function fetchPhoto(ac) {
  const key = photoKey(ac);
  if (!key || photoCache.has(key)) return photoCache.get(key);
  photoCache.set(key, null);
  const endpoint = ac.registration
    ? `reg/${encodeURIComponent(ac.registration)}`
    : `hex/${encodeURIComponent(ac.icao24)}`;
  try {
    const resp = await fetch(
      `https://api.planespotters.net/pub/photos/${endpoint}`,
    );
    if (resp.ok) {
      const d = await resp.json();
      const photo = (d.photos || [])[0];
      const src = photo && (photo.thumbnail_large?.src || photo.thumbnail?.src);
      if (src) photoCache.set(key, src);
    }
  } catch (err) {
    /* best-effort: leave the card without a photo */
  }
  return photoCache.get(key);
}

// ----- Route (origin/destination) -----
// Format an airport as "City (CODE) / Country", e.g. "Sofia (SOF) / Bulgaria".
// Falls back to "N/A" when the route/airport data is unavailable.
function airportText(ap) {
  if (!ap) return "N/A";
  const city = ap.city || "";
  const code = ap.code || "";
  const country = ap.country || "";
  const head = city && code ? `${city} (${code})` : city || code;
  const text = [head, country].filter(Boolean).join(" / ");
  return text || "N/A";
}

// Always show From/To (N/A when missing) so the layout is consistent.
function routeHtml(ac) {
  return (
    `<div class="route">` +
    `<div class="route-line">From: ${airportText(ac.origin)}</div>` +
    `<div class="route-line">To: ${airportText(ac.destination)}</div>` +
    `</div>`
  );
}

// ----- Selection: toggle a single aircraft filter -----
function selectAircraft(icao) {
  selectedIcao = selectedIcao === icao ? null : icao;
  renderCards();
}

// Human-friendly status label shown on the badge. Class names stay
// arriving/departing/cruising (for colors); only the displayed text changes.
function statusLabel(ac) {
  if (ac._landed) return "landed";
  if (ac.classification === "arriving") return "landing";
  if (ac.classification === "departing") return "taking off";
  return ac.classification;
}

// ----- Aircraft cards -----
// Order: arriving/departing first, then airborne cruising, then landed at the bottom.
function cardPriority(ac) {
  if (ac._landed) return 2;
  if (ac.classification === "arriving" || ac.classification === "departing") return 0;
  return 1;
}

function renderCards() {
  const sorted = [...lastList].sort((a, b) => {
    const pa = cardPriority(a);
    const pb = cardPriority(b);
    if (pa !== pb) return pa - pb;
    return a._dist - b._dist;
  });

  cardsEl.innerHTML = "";
  cardsEl.classList.toggle("has-selection", selectedIcao !== null);
  const now = Date.now();

  // Drop alerts whose flash window has elapsed.
  for (const [id, deadline] of notified) {
    if (now >= deadline) notified.delete(id);
  }

  for (const ac of sorted) {
    const card = document.createElement("div");
    const isSelected = selectedIcao === ac.icao24;
    const stateClass = ac._landed ? "landed" : ac.classification;
    const isNotifying = !ac._landed && notified.has(ac.icao24);
    card.className =
      `card ${stateClass}` +
      `${isSelected ? " selected" : ""}` +
      `${isNotifying ? " notify-active" : ""}`;
    card.dataset.icao = ac.icao24;

    const callsign = ac.callsign || ac.icao24 || "——";
    const type = ac.type ? `<span class="type">${ac.type}</span>` : "";
    const alt = `<span class="alt">${Math.round(ac.altitude_m)} m</span>`;

    const key = photoKey(ac);
    const url = key ? photoCache.get(key) : null;
    if (url === undefined) fetchPhoto(ac);
    const photoHtml = url
      ? `<img class="card-photo" src="${url}" alt="" />`
      : `<div class="card-photo placeholder"></div>`;

    card.innerHTML = `
      ${photoHtml}
      <div class="card-body">
        <div class="card-top">
          <span class="callsign">${callsign}</span>
          <span class="badge">${statusLabel(ac)}</span>
        </div>
        <div class="type-alt">${type} ${alt}</div>
        ${routeHtml(ac)}
        <div class="meta">
          ${ac._dist.toFixed(1)} km · brg ${Math.round((ac._bearing + 360) % 360)}°
          · hdg ${Math.round(ac.heading_deg)}°
          · ${Math.round(ac.velocity_kmh)} km/h
        </div>
      </div>`;

    card.addEventListener("click", () => selectAircraft(ac.icao24));
    cardsEl.appendChild(card);

    // Bring the just-notified card into view so the sound has a visual anchor.
    if (pendingScrollIcao === ac.icao24) {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      pendingScrollIcao = null;
    }
  }
}

// ----- Render loop -----
function drawBackground(cx, cy, R) {
  ctx.strokeStyle = "rgba(0, 255, 102, 0.35)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= RING_COUNT; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (R * i) / RING_COUNT, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(0, 255, 102, 0.25)";
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();

  ctx.fillStyle = "rgba(0, 255, 102, 0.8)";
  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", cx, cy - R + 11);
  ctx.fillText("S", cx, cy + R - 11);
  ctx.fillText("E", cx + R - 11, cy);
  ctx.fillText("W", cx - R + 11, cy);

  ctx.fillStyle = "rgba(0, 255, 102, 0.6)";
  ctx.font = "13px monospace";
  ctx.textAlign = "left";
  ctx.fillText(`${Math.round(state.radius)} km`, cx + 6, cy - R * 0.5);
}

function drawSweep(cx, cy, R) {
  const TRAIL = 28;
  const step = 0.06;
  for (let i = 0; i < TRAIL; i++) {
    const a = sweepAngle - i * step;
    const alpha = 0.16 * (1 - i / TRAIL);
    ctx.strokeStyle = `rgba(0, 255, 102, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.sin(a), cy - R * Math.cos(a));
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(150, 255, 190, 0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + R * Math.sin(sweepAngle), cy - R * Math.cos(sweepAngle));
  ctx.stroke();
}

function updateRadar(prevAngle, curAngle, dt) {
  for (const [id, blip] of rendered) {
    blip.intensity -= dt / FADE_SECONDS;
    if (blip.intensity <= 0) rendered.delete(id);
  }
  for (const [id, ac] of incoming) {
    if (sweepCrossed(prevAngle, curAngle, toRad(ac._bearing))) {
      rendered.set(id, { ...ac, intensity: 1 });
    }
  }
}

function drawAircraft(cx, cy, R) {
  blipPositions.clear();
  const isFiltered = selectedIcao !== null;

  for (const blip of rendered.values()) {
    if (blip._frac > 1) continue;
    const intensity = blip.intensity;
    if (intensity <= 0.03) continue;

    const r = blip._frac * R;
    const x = cx + r * Math.sin(toRad(blip._bearing));
    const y = cy - r * Math.cos(toRad(blip._bearing));
    const color = COLORS[blip.classification] || "#00ff66";
    const isSelected = blip.icao24 === selectedIcao;

    blipPositions.set(blip.icao24, { x, y });

    if (isFiltered && !isSelected) {
      // Non-selected: dim dot only
      ctx.globalAlpha = intensity * 0.15;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }

    ctx.globalAlpha = intensity;

    if (intensity > 0.4) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 16);
      glow.addColorStop(0, color);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save();
      ctx.globalAlpha = intensity * 0.35;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(toRad(blip.heading_deg));
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(-5, 6);
    ctx.lineTo(5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(0, -18);
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "bold 13px monospace";
    const lx = x + 9;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(blip.callsign || blip.icao24, lx, y - 10);
    if (blip.type) {
      ctx.fillStyle = "#59d6ff";
      ctx.fillText(blip.type, lx, y + 1);
    }
    ctx.fillStyle = "#00ff66";
    ctx.fillText(`${Math.round(blip.altitude_m)} m`, lx, y + 12);

    ctx.globalAlpha = 1;
  }
}

function frame(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  const prevAngle = sweepAngle;
  sweepAngle = (sweepAngle + SWEEP_SPEED * dt) % TAU;
  updateRadar(prevAngle, sweepAngle, dt);

  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 6;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = "rgba(0, 40, 15, 0.35)";
  ctx.fillRect(0, 0, size, size);

  drawBackground(cx, cy, R);
  drawSweep(cx, cy, R);
  drawAircraft(cx, cy, R);

  ctx.restore();
  requestAnimationFrame(frame);
}

// ----- Canvas click: select aircraft by clicking its blip -----
canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  let hit = null;
  let minDist = 24; // CSS pixel click tolerance
  for (const [icao, pos] of blipPositions) {
    const dx = mx - pos.x;
    const dy = my - pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < minDist) {
      minDist = d;
      hit = icao;
    }
  }
  selectAircraft(hit); // null = deselect
});

// ----- Wire up -----
form.addEventListener("submit", (e) => {
  e.preventDefault();
  triggerUpdate();
});

for (const input of [latInput, lonInput, radiusInput]) {
  input.addEventListener("change", persistParams);
}

mockToggle.addEventListener("click", () => {
  mockMode = !mockMode;
  localStorage.setItem("mockMode", String(mockMode));
  updateMockButton();
  triggerUpdate();
});

// Sound on/off: flip and remember. Turning it on doubles as the user gesture
// that unlocks audio playback (browser autoplay policy).
soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem("soundEnabled", String(soundEnabled));
  updateSoundButton();
  if (soundEnabled) getAudioCtx().resume?.();
});

window.addEventListener("resize", resizeCanvas);

loadParams();
const initial = readInputs();
if (!Number.isNaN(initial.lat) && !Number.isNaN(initial.lon)) {
  state.center = { lat: initial.lat, lon: initial.lon };
}
if (!Number.isNaN(initial.radius)) state.radius = initial.radius;

resizeCanvas();
updateMockButton();
updateSoundButton();
triggerUpdate();
requestAnimationFrame(frame);
