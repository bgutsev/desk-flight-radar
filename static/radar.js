"use strict";

// ----- Config -----
const FETCH_INTERVAL_MS = 2000;
const RING_COUNT = 4;
const SWEEP_SPEED = 2.0; // radians / second
const TAU = Math.PI * 2;
// A blip lit by the sweep fades over exactly one rotation, so it is nearly
// gone by the time the sweep comes back around to it.
const FADE_SECONDS = TAU / SWEEP_SPEED;
const COLORS = {
  arriving: "#00ff66",
  departing: "#ffb300",
  cruising: "#2b6cff",
};
const NEARBY_FRACTION = 1 / 3; // "landing nearby" threshold (of radius)

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
const noticeEl = document.getElementById("notice");
const statusEl = document.getElementById("status-line");
const cardsEl = document.getElementById("cards");
const dataStatusEl = document.getElementById("data-status");
const dataStatusMsg = document.getElementById("data-status-msg");
const mockToggle = document.getElementById("mock-toggle");
const mockLabel = document.getElementById("mock-label");
const alertsEl = document.getElementById("alerts");

// ----- State -----
const state = {
  // Sofia Airport (LBSF / SOF).
  center: { lat: 42.6967, lon: 23.4114 },
  radius: 25,
};

// Mock mode is a sticky user preference.
let mockMode = localStorage.getItem("mockMode") === "true";

// `incoming` holds the freshest fetched data (buffered, no visual effect on its
// own). `rendered` holds what is actually drawn: each blip is committed from
// `incoming` — its position frozen and intensity flashed to 1 — only at the
// instant the sweep line passes its bearing. `lastList` feeds the side panel.
const incoming = new Map(); // icao24 -> aircraft (with _dist/_bearing/_frac)
const rendered = new Map(); // icao24 -> { ...aircraft, intensity }
let lastList = [];

let size = 0; // CSS pixel size of the square canvas
let sweepAngle = 0;
let lastFrame = performance.now();
let noticeTimer = null;

// Exactly one polling loop. Stored globally so it can be strictly destroyed
// before a new one starts (Update / Mock toggle / Enter) — no interval leak.
let intervalId = null;
// Drop overlapping ticks: never run a second fetch while one is in flight.
let fetchInFlight = false;
// Monotonic id so a slow/stale response is discarded — only the most recent
// request is ever applied to the UI.
let requestSeq = 0;

// Cached flight routes by callsign: object = known, null = unknown/failed.
const routeCache = new Map();

// Aircraft already seen on radar (icao24), to detect newcomers. `firstLoad`
// suppresses an alert burst for the initial fleet (and after a mode switch).
let seenIds = new Set();
let firstLoad = true;

const normAngle = (a) => ((a % TAU) + TAU) % TAU;

// Did the sweep, moving from `prev` to `cur`, pass angle `t` this frame?
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

// ----- Inputs / mode -----
function readInputs() {
  return {
    lat: parseFloat(document.getElementById("lat").value),
    lon: parseFloat(document.getElementById("lon").value),
    radius: parseFloat(document.getElementById("radius").value),
  };
}

function updateMockButton() {
  mockToggle.classList.toggle("mock-on", mockMode);
  mockToggle.setAttribute("aria-checked", String(mockMode));
  mockLabel.textContent = mockMode ? "MOCK" : "LIVE";
}

// ----- Data-link warning light (with message) -----
function setWarning(on, msg = "") {
  dataStatusEl.classList.toggle("alert", on);
  dataStatusMsg.textContent = on ? msg : "";
}

// ----- Landing notification (informational, not an error) -----
function showNotice(message) {
  noticeEl.textContent = message;
  noticeEl.classList.remove("fade");
  noticeEl.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeEl.classList.add("fade");
    setTimeout(() => {
      noticeEl.hidden = true;
    }, 400);
  }, 5000);
}

// ----- Data loop (fails silently, keeping the last known data) -----
async function fetchData() {
  const { lat, lon, radius } = readInputs();
  if (Number.isNaN(lat) || Number.isNaN(lon) || Number.isNaN(radius)) {
    return; // invalid input: do nothing, keep showing the last data
  }

  const myReq = ++requestSeq;

  const params = new URLSearchParams({
    lat: lat,
    lon: lon,
    radius_km: radius,
    mock: mockMode ? "true" : "false",
  });

  try {
    const resp = await fetch(`/aircraft?${params.toString()}`);
    if (!resp.ok) {
      setWarning(true, "SERVER ERROR"); // keep last data
      return;
    }
    const data = await resp.json();

    // Apply only the most recent request; ignore a stale/late response.
    if (myReq !== requestSeq) return;

    state.center = data.center;
    state.radius = data.radius_km;

    const list = data.aircraft
      // Drop aircraft with no/zero altitude (on-ground or unknown).
      .filter((ac) => ac.altitude_m > 0)
      .map((ac) => {
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
        // _frac freezes the radial position independent of later radius edits.
        return { ...ac, _dist: dist, _bearing: brg, _frac: dist / data.radius_km };
      });

    // Buffer for the radar; committed to screen as the sweep passes each blip.
    incoming.clear();
    for (const ac of list) incoming.set(ac.icao24, ac);

    lastList = list;
    statusEl.textContent =
      `${list.length} aircraft · ` +
      `${data.mock ? "MOCK" : "LIVE"} · updated ${new Date().toLocaleTimeString()}`;

    // Alert on any aircraft newly caught by the radar (skip the first load).
    if (!firstLoad) {
      for (const ac of list) {
        if (!seenIds.has(ac.icao24)) spawnPlaneAlert(ac);
      }
    }
    seenIds = new Set(list.map((ac) => ac.icao24));
    firstLoad = false;

    renderCards();
    maybeNotifyNearby();

    // Healthy only when we actually have data; blink on empty results.
    setWarning(list.length === 0, "NO DATA");
  } catch (err) {
    setWarning(true, "NO CONNECTION"); // network error: keep last data
  }
}

// Build a 1-minute alert card (with a photo) for a newly caught aircraft.
function spawnPlaneAlert(ac) {
  const el = document.createElement("div");
  el.className = `plane-alert ${ac.classification}`;
  const name = ac.callsign || ac.icao24 || "——";
  const sub = [ac.type, ac.registration].filter(Boolean).join(" · ");
  el.innerHTML = `
    <img class="photo" alt="" hidden />
    <div class="info">
      <div class="title">${name} <span class="cls">${ac.classification}</span></div>
      <div class="sub">${sub}</div>
      <div class="route"></div>
      <div class="tag">NEW CONTACT</div>
    </div>`;
  alertsEl.appendChild(el);

  loadPlanePhoto(ac, el.querySelector(".photo"));
  fetchRoute(ac.callsign).then((route) => {
    const r = el.querySelector(".route");
    if (route && r) r.textContent = `✈ ${route.from} → ${route.to}`;
  });

  // Auto-remove after one minute.
  setTimeout(() => el.remove(), 60000);
}

// Fetch a photo from planespotters by registration (preferred) or hex.
async function loadPlanePhoto(ac, img) {
  const endpoint = ac.registration
    ? `reg/${encodeURIComponent(ac.registration)}`
    : `hex/${encodeURIComponent(ac.icao24)}`;
  try {
    const resp = await fetch(
      `https://api.planespotters.net/pub/photos/${endpoint}`,
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const photo = (data.photos || [])[0];
    const src = photo && (photo.thumbnail_large?.src || photo.thumbnail?.src);
    if (src) {
      img.src = src;
      img.hidden = false;
    }
  } catch (err) {
    /* best-effort: leave the card without a photo */
  }
}

// One fetch at a time — a tick that lands while a request is still running is
// dropped, so requests never pile up into concurrent calls.
async function runFetch() {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    await fetchData();
  } finally {
    fetchInFlight = false;
  }
}

// (Re)start the single polling loop, strictly destroying any previous one first.
function startPolling() {
  clearInterval(intervalId);
  intervalId = setInterval(runFetch, FETCH_INTERVAL_MS);
}

// Force an immediate fetch and restart the loop (Enter, Update, or mode switch).
// Bumping requestSeq invalidates any in-flight response so only this newest
// request is shown.
function triggerUpdate() {
  requestSeq++;
  clearInterval(intervalId); // destroy the old loop before starting a new one
  runFetch(); // fetch immediately, don't wait for the interval
  startPolling();
}

// ----- Flight route (from → to) via adsbdb, cached by callsign -----
function airportLabel(ap) {
  const place =
    ap.municipality || ap.name || ap.iata_code || ap.icao_code || ap.country_iso_name;
  const code = ap.iata_code || ap.icao_code;
  return code && place && place !== code ? `${place} (${code})` : place || "?";
}

async function fetchRoute(callsign) {
  if (!callsign) return null;
  if (routeCache.has(callsign)) return routeCache.get(callsign);
  routeCache.set(callsign, null); // reserve to avoid duplicate lookups
  try {
    const resp = await fetch(
      `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
    );
    if (resp.ok) {
      const d = await resp.json();
      const fr = d.response && d.response.flightroute;
      if (fr && fr.origin && fr.destination) {
        routeCache.set(callsign, {
          from: airportLabel(fr.origin),
          to: airportLabel(fr.destination),
        });
      }
    }
  } catch (err) {
    /* leave as null (unknown) */
  }
  return routeCache.get(callsign);
}

function maybeNotifyNearby() {
  const nearby = lastList
    .filter((ac) => ac.classification === "arriving")
    .filter((ac) => ac._dist <= state.radius * NEARBY_FRACTION)
    .sort((a, b) => a._dist - b._dist);
  if (nearby.length) {
    const ac = nearby[0];
    const name = ac.callsign || ac.icao24;
    showNotice(`${name} — landing nearby (${ac._dist.toFixed(0)} km)`);
  }
}

// ----- Aircraft cards (panel updates immediately on fetch) -----
function renderCards() {
  // Arriving/departing on top (closest to centre first), then everything else.
  const priority = (c) => (c === "arriving" || c === "departing" ? 0 : 1);
  const sorted = [...lastList].sort((a, b) => {
    const pa = priority(a.classification);
    const pb = priority(b.classification);
    if (pa !== pb) return pa - pb;
    return a._dist - b._dist;
  });
  cardsEl.innerHTML = "";
  for (const ac of sorted) {
    const card = document.createElement("div");
    card.className = `card ${ac.classification}`;

    const callsign = ac.callsign || ac.icao24 || "——";
    const type = ac.type ? `<span class="type">${ac.type}</span>` : "";
    const alt = `<span class="alt">${Math.round(ac.altitude_m)} m</span>`;

    // Route appears on a later render once the lookup resolves and is cached.
    const route = routeCache.get(ac.callsign);
    if (route === undefined && ac.callsign) fetchRoute(ac.callsign);
    const routeHtml = route
      ? `<div class="route">✈ ${route.from} → ${route.to}</div>`
      : "";

    card.innerHTML = `
      <span class="callsign">${callsign}</span>
      <span class="badge">${ac.classification}</span>
      <div>${type} ${alt}</div>
      ${routeHtml}
      <div class="meta">
        ${ac._dist.toFixed(1)} km · brg ${Math.round((ac._bearing + 360) % 360)}°
        · hdg ${Math.round(ac.heading_deg)}°
        · ${Math.round(ac.velocity_kmh)} km/h
      </div>`;
    cardsEl.appendChild(card);
  }
}

// ----- Render loop -----
function drawBackground(cx, cy, R) {
  // Range rings
  ctx.strokeStyle = "rgba(0, 255, 102, 0.35)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= RING_COUNT; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (R * i) / RING_COUNT, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Crosshairs
  ctx.strokeStyle = "rgba(0, 255, 102, 0.25)";
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();

  // Cardinal labels
  ctx.fillStyle = "rgba(0, 255, 102, 0.8)";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", cx, cy - R + 9);
  ctx.fillText("S", cx, cy + R - 9);
  ctx.fillText("E", cx + R - 9, cy);
  ctx.fillText("W", cx - R + 9, cy);

  // Range label (outer ring distance)
  ctx.fillStyle = "rgba(0, 255, 102, 0.6)";
  ctx.font = "10px monospace";
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
  // Bright leading arm
  ctx.strokeStyle = "rgba(150, 255, 190, 0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + R * Math.sin(sweepAngle), cy - R * Math.cos(sweepAngle));
  ctx.stroke();
}

// Commit buffered aircraft to the screen exactly when the sweep passes their
// bearing (freezing position + flashing to full intensity); decay the rest.
function updateRadar(prevAngle, curAngle, dt) {
  // Fade everything already on screen.
  for (const [id, blip] of rendered) {
    blip.intensity -= dt / FADE_SECONDS;
    if (blip.intensity <= 0) rendered.delete(id);
  }
  // Light up the blips the sweep just crossed, snapshotting current position.
  for (const [id, ac] of incoming) {
    if (sweepCrossed(prevAngle, curAngle, toRad(ac._bearing))) {
      rendered.set(id, { ...ac, intensity: 1 });
    }
  }
}

function drawAircraft(cx, cy, R) {
  for (const blip of rendered.values()) {
    if (blip._frac > 1) continue; // outside the current ring
    const intensity = blip.intensity;
    if (intensity <= 0.03) continue;

    const r = blip._frac * R;
    const x = cx + r * Math.sin(toRad(blip._bearing));
    const y = cy - r * Math.cos(toRad(blip._bearing));
    const color = COLORS[blip.classification] || "#00ff66";

    ctx.globalAlpha = intensity;

    // Soft glow right after a hit
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

    // Oriented triangle + forward direction line
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

    // Upright label block (fades with the blip)
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "bold 10px monospace";
    const lx = x + 9;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(blip.callsign || blip.icao24, lx, y - 9);
    if (blip.type) {
      ctx.fillStyle = "#59d6ff";
      ctx.fillText(blip.type, lx, y + 1);
    }
    ctx.fillStyle = "#00ff66";
    ctx.fillText(`${Math.round(blip.altitude_m)} m`, lx, y + 11);

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

  // Clip everything to the round screen.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.clip();

  // Faint screen glow
  ctx.fillStyle = "rgba(0, 40, 15, 0.35)";
  ctx.fillRect(0, 0, size, size);

  drawBackground(cx, cy, R);
  drawSweep(cx, cy, R);
  drawAircraft(cx, cy, R);

  ctx.restore();
  requestAnimationFrame(frame);
}

// ----- Wire up -----
// Enter in any input submits the form; both Enter and Update force an
// immediate fetch instead of waiting for the interval.
form.addEventListener("submit", (e) => {
  e.preventDefault();
  triggerUpdate();
});

// Mock/Live toggle: flip mode, remember it, and re-fetch immediately.
mockToggle.addEventListener("click", () => {
  mockMode = !mockMode;
  localStorage.setItem("mockMode", String(mockMode));
  updateMockButton();
  // The whole fleet changes on a mode switch — re-baseline so we don't alert
  // for every aircraft in the new mode.
  firstLoad = true;
  alertsEl.innerHTML = "";
  triggerUpdate();
});

window.addEventListener("resize", resizeCanvas);

resizeCanvas();
updateMockButton();
triggerUpdate();
requestAnimationFrame(frame);
