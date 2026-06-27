"use strict";

// ----- Config (defaults from static/config.js; user-editable) -----
const CONFIG = window.RADAR_CONFIG || {};
const FETCH_INTERVAL_MS = CONFIG.FETCH_INTERVAL_MS ?? 2000;
const RING_COUNT = CONFIG.RING_COUNT ?? 4;
const SWEEP_SPEED = CONFIG.SWEEP_SPEED ?? 2.0; // radians / second
const NEARBY_FRACTION = CONFIG.NEARBY_FRACTION ?? 1 / 3;
const DEFAULT_CENTER = {
  lat: CONFIG.DEFAULT_LAT ?? 42.6967,
  lon: CONFIG.DEFAULT_LON ?? 23.4167,
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

// Number of altitude readings to keep per aircraft. The vertical rate is
// derived across this window (~ this many polls) so brief GPS noise is smoothed.
const ALT_HISTORY_SIZE = 3;

// Above this geometric altitude (m) an aircraft is en-route, shown as cruising
// regardless of any descent (e.g. a step-down well above the field). Mirrors the
// backend's CRUISE_ALTITUDE_M.
const CRUISE_ALT_M = 8000.0;

// Derived vertical speed (m/s) beyond which an aircraft counts as climbing or
// descending. 1.0 m/s ≈ 200 ft/min, mirroring the backend's CLIMB_THRESHOLD_FPM.
const VERT_RATE_MS = 1.0;

// Reported vertical rate (ft/min) above which an aircraft is climbing — used
// only as a fallback for brand-new contacts that lack an altitude trend yet. A
// climbing aircraft is taking off, so it is never treated as on-ground/landed.
const CLIMB_RATE_FPM = 200.0;

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

// ----- Aircraft signal helpers -----
// Geometric (GPS/WGS84) altitude and vertical rate are pressure-independent;
// prefer them over the barometric values (which drift with QNH), falling back
// when the source omits them. `??` keeps a valid 0 (e.g. on the ground).
const altM = (ac) => ac.altitude_geom_m ?? ac.altitude_m;
const climbRateFpm = (ac) => ac.geom_rate_fpm ?? ac.vertical_rate_fpm;
// The ADS-B air/ground status bit is authoritative; the backend "ground"
// classification (geom altitude within the calibrated field band) backs it up.
const isOnGround = (ac) =>
  ac.on_ground === true ||
  (climbRateFpm(ac) <= CLIMB_RATE_FPM && ac.classification === "ground");

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
const soundIconEl = document.getElementById("sound-icon");

const SVG_SPEAKER = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
const SVG_MUTED = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
const latInput = document.getElementById("lat");
const lonInput = document.getElementById("lon");
const radiusInput = document.getElementById("radius");
const markLatInput = document.getElementById("mark-lat");
const markLonInput = document.getElementById("mark-lon");
const markClearBtn = document.getElementById("mark-clear");

// ----- State -----
const state = {
  center: { ...DEFAULT_CENTER },
  radius: DEFAULT_RADIUS,
  // Optional static reference point plotted on the radar (null when unset).
  marker: null,
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
// Classification each aircraft showed on the previous poll, so we can ding on
// *entry* into an alert state (arriving/departing) — including a plane that was
// already on the radar as cruising/ground and then climbs out as "departing".
const alertedClass = new Map(); // icao24 -> trend classification (_effective) last poll
// icao24s that have already dinged during their current stretch of presence on
// the radar. Cleared only when the aircraft leaves (same lifecycle as
// alertedClass), so each contact dings once per appearance — state flips while
// it stays on screen (e.g. arriving->departing, or classification jitter) do
// not re-ding. A genuine return after leaving dings again.
const alertedWhilePresent = new Set();
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

// Altitude history per aircraft, used to derive the vertical rate from the
// altitude we actually observe changing between polls (the reported baro/geom
// rate is often zero or missing even during a clear descent).
const altHistory = new Map(); // icao24 -> [{alt, ts}, ...] last ALT_HISTORY_SIZE entries

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
// Round a coordinate to 5 decimal places (~1 m precision), dropping trailing
// zeros. NaN passes through unchanged.
function round5(v) {
  return Math.round(v * 1e5) / 1e5;
}

// Normalise a coordinate field's displayed value to 5 decimals (e.g. after a
// long paste).
function normalizeCoord(input) {
  const v = parseFloat(input.value);
  if (!Number.isNaN(v)) input.value = String(round5(v));
}

function readInputs() {
  return {
    lat: round5(parseFloat(latInput.value)),
    lon: round5(parseFloat(lonInput.value)),
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
  const markLat = localStorage.getItem("markLat");
  const markLon = localStorage.getItem("markLon");
  if (markLat !== null) markLatInput.value = markLat;
  if (markLon !== null) markLonInput.value = markLon;
}

function persistParams() {
  const { lat, lon, radius } = readInputs();
  if (!Number.isNaN(lat)) localStorage.setItem("lat", String(lat));
  if (!Number.isNaN(lon)) localStorage.setItem("lon", String(lon));
  if (!Number.isNaN(radius)) localStorage.setItem("radius", String(radius));
  // Marker is optional: store when both set, otherwise clear.
  if (markLatInput.value && markLonInput.value) {
    localStorage.setItem("markLat", markLatInput.value);
    localStorage.setItem("markLon", markLonInput.value);
  } else {
    localStorage.removeItem("markLat");
    localStorage.removeItem("markLon");
  }
}

// Read the optional marker inputs into state.marker (null unless both valid).
function updateMarker() {
  const mlat = round5(parseFloat(markLatInput.value));
  const mlon = round5(parseFloat(markLonInput.value));
  state.marker =
    Number.isNaN(mlat) || Number.isNaN(mlon) ? null : { lat: mlat, lon: mlon };
}

function updateMockButton() {
  mockToggle.classList.toggle("live-on", !mockMode);
  mockToggle.setAttribute("aria-checked", String(!mockMode));
  mockLabel.textContent = mockMode ? "MOCK" : "LIVE";
}

function updateSoundButton() {
  soundToggle.classList.toggle("sound-on", soundEnabled);
  soundToggle.setAttribute("aria-checked", String(soundEnabled));
  soundIconEl.innerHTML = soundEnabled ? SVG_SPEAKER : SVG_MUTED;
  soundIconEl.classList.toggle("muted", !soundEnabled);
}

// ----- Data-link status light -----
// state: "ok" (solid green, steady) | "error" (red blinking + red text) |
// "nodata" (green dot + amber text, breathing in sync).
function setDataStatus(state, msg = "") {
  dataStatusEl.classList.toggle("error", state === "error");
  dataStatusEl.classList.toggle("nodata", state === "nodata");
  dataStatusMsg.textContent = msg;
}

// ----- Audio alerts -----
function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// AudioContext is unlocked only when the user explicitly clicks YES in the
// notification modal, or when they turn the sound toggle on manually.

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

// ----- Vertical trend (altitude derived rate) -----
// Append one altitude sample, keeping only the last ALT_HISTORY_SIZE readings.
function recordAltitude(icao, altM, ts) {
  let history = altHistory.get(icao);
  if (history === undefined) {
    history = [];
    altHistory.set(icao, history);
  }
  history.push({ alt: altM, ts });
  if (history.length > ALT_HISTORY_SIZE) history.shift();
  return history;
}

// Vertical speed (m/s) derived from the oldest→newest sample in the window.
// Returns null until there are two samples spanning a usable interval — the
// only reliable way to know a plane is climbing/descending when the reported
// rate field is zero or missing. Positive = climbing.
function derivedRateMs(history) {
  if (history.length < 2) return null;
  const first = history[0];
  const last = history[history.length - 1];
  const dt = (last.ts - first.ts) / 1000;
  if (dt <= 0) return null;
  return (last.alt - first.alt) / dt;
}

// Classify an airborne aircraft from the altitude trend we actually observe,
// rather than the reported rate. Ground comes from the ADS-B bit / backend
// band; the reported rate is only a fallback for contacts too new to have a trend.
function classifyByTrend(ac, now) {
  const history = recordAltitude(ac.icao24, altM(ac), now);
  if (isOnGround(ac)) return "ground";
  if (altM(ac) > CRUISE_ALT_M) return "cruising"; // high en-route, ignore trend

  const rate = derivedRateMs(history);
  if (rate === null) {
    // Brand-new contact: fall back to the reported rate for one tick.
    if (climbRateFpm(ac) > CLIMB_RATE_FPM) return "departing";
    if (climbRateFpm(ac) < -CLIMB_RATE_FPM) return "arriving";
    return ac.classification;
  }
  if (rate < -VERT_RATE_MS) return "arriving";
  if (rate > VERT_RATE_MS) return "departing";
  return "cruising"; // level → overflying/transit
}

// ----- Classification smoothing -----
// Resist brief flips: a new classification only takes effect once it has held
// for CLASS_STABLE_MS. Brand-new contacts adopt their classification at once.
function smoothClass(icao, raw, now) {
  // Ground state is never delayed — show it immediately so the filter loop
  // can gate on it within the same poll.
  if (raw === "ground") {
    shownClass.set(icao, "ground");
    pendingClass.delete(icao);
    return "ground";
  }
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
// Ding whenever an aircraft *enters* an alert state (arriving/departing) — both
// a brand-new contact that appears already arriving/departing AND one already on
// the radar that transitions in (e.g. a plane that sat near the field as
// ground and then climbs out as "taking off"). The alert keys off `_effective`
// — the trend classification *before* display smoothing and the landed grace —
// so a fast ground→departing isn't masked by either and goes unheard. Staying in
// the state does not re-ding. If several enter at once the farthest one wins (it
// just crossed into scope); its card breathes and scrolls into view as the anchor.
function detectNewAircraft(list, now) {
  let alertAc = null;
  let alertDist = -1;
  const present = new Set();
  for (const ac of list) {
    present.add(ac.icao24);
    const eff = ac._effective;
    const isAlertState = eff === "arriving" || eff === "departing";
    const isEntry = alertedClass.get(ac.icao24) !== eff;
    if (
      isAlertState &&
      isEntry &&
      !alertedWhilePresent.has(ac.icao24) &&
      ac._dist > alertDist
    ) {
      alertAc = ac;
      alertDist = ac._dist;
    }
  }
  // Record this poll's trend state for everyone present (and drop the gone) so
  // the next poll can detect a fresh transition rather than a sustained state.
  // Aircraft that have left also lose their once-per-presence ding lock, so a
  // genuine return dings again.
  for (const id of alertedClass.keys()) if (!present.has(id)) alertedClass.delete(id);
  for (const id of alertedWhilePresent) if (!present.has(id)) alertedWhilePresent.delete(id);
  for (const ac of list) alertedClass.set(ac.icao24, ac._effective);

  if (alertAc !== null) {
    alertedWhilePresent.add(alertAc.icao24);
    notified.set(alertAc.icao24, now + CARD_NOTICE_MS);
    pendingScrollIcao = alertAc.icao24;
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
      setDataStatus("error", "SERVER ERROR");
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
      const effective = classifyByTrend(ac, now);
      const cls = smoothClass(ac.icao24, effective, now);
      return {
        ...ac,
        classification: cls,
        // Trend classification before display smoothing/landed-grace masking.
        // Alerts key off this so a fast ground→departing isn't swallowed by the
        // 5 s smoothing or the landed grace.
        _effective: effective,
        _dist: dist,
        _bearing: brg,
        _frac: dist / data.radius_km,
      };
    });

    // Track landings: an aircraft we previously saw airborne and now on the
    // ground just landed. Keep only currently-present aircraft in the tracking
    // maps so a craft that disappears and reappears grounded isn't mistaken for
    // a landing.
    const present = new Set();
    for (const ac of enriched) {
      present.add(ac.icao24);
      // A departing aircraft is climbing out, not landing — never count it as
      // on-ground, even if its altitude dips into the field band. "departing"
      // now comes from the observed altitude trend, so it's reliable here.
      const climbing = ac.classification === "departing";
      const onGround = !climbing && isOnGround(ac);
      if (onGround) {
        if (prevGround.get(ac.icao24) === false) landedAt.set(ac.icao24, now);
      } else if (climbing) {
        landedAt.delete(ac.icao24); // climbing out / confirmed takeoff — cancel grace
      }
      // "arriving" at low altitude does NOT clear landedAt (noise near the ground)
      prevGround.set(ac.icao24, onGround);
    }
    for (const id of prevGround.keys()) if (!present.has(id)) prevGround.delete(id);
    for (const id of landedAt.keys()) if (!present.has(id)) landedAt.delete(id);
    for (const id of shownClass.keys()) if (!present.has(id)) shownClass.delete(id);
    for (const id of pendingClass.keys()) if (!present.has(id)) pendingClass.delete(id);
    for (const id of altHistory.keys()) if (!present.has(id)) altHistory.delete(id);

    // Show airborne aircraft, plus grounded ones only within the landing grace.
    // "Ground" means the ADS-B air/ground bit is set OR the backend classified
    // it as "ground" (geometric altitude within the calibrated field band).
    // Grounded-and-kept aircraft are tagged `_landed` for styling/sorting.
    const list = [];
    for (const ac of enriched) {
      const onGround = isOnGround(ac);
      const t = landedAt.get(ac.icao24);
      const withinGrace = t !== undefined && now - t < LANDED_GRACE_MS;

      if (onGround) {
        // On ground and recently transitioned from airborne → show as landed.
        if (withinGrace) list.push({ ...ac, _landed: true });
        // else: sitting there before we first noticed, never shown.
      } else if (withinGrace && ac.classification !== "departing") {
        // Briefly outside ground band (baro noise) but still within grace and
        // not climbing away — keep the grey landed card rather than flashing
        // back to "landing".
        list.push({ ...ac, _landed: true });
      } else {
        list.push(ac);
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

    setDataStatus(list.length === 0 ? "nodata" : "ok", list.length === 0 ? "NO DATA" : "");
  } catch (err) {
    setDataStatus("error", "NO CONNECTION");
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
    // Card shows the full aircraft name; the radar blip keeps the short code.
    const fullType = ac.type_full || ac.type;
    const type = fullType ? `<span class="type">${fullType}</span>` : "";
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
          ${alt}
        </div>
        <div class="type-line">${type}</div>
        ${routeHtml(ac)}
        <div class="meta">
          ${ac._dist.toFixed(1)} km · brg ${Math.round((ac._bearing + 360) % 360)}°
          · hdg ${Math.round(ac.heading_deg)}°
          · <span class="speed">${Math.round(ac.velocity_kmh)} km/h</span>
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

  // Cross lines, with a gap at each arm end so no line runs behind the
  // compass letters.
  const GAP = 22;
  ctx.strokeStyle = "rgba(0, 255, 102, 0.25)";
  ctx.beginPath();
  ctx.moveTo(cx - R + GAP, cy);
  ctx.lineTo(cx + R - GAP, cy);
  ctx.moveTo(cx, cy - R + GAP);
  ctx.lineTo(cx, cy + R - GAP);
  ctx.stroke();

  // Ring distances along the right (East) arm — small, rounded km with no unit,
  // right-anchored just inside each ring line (above the arm) so the numbers sit
  // between the arcs instead of overlapping them.
  ctx.fillStyle = "rgba(120, 255, 180, 0.85)";
  ctx.font = "9px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  for (let i = 1; i <= RING_COUNT; i++) {
    const ringR = (R * i) / RING_COUNT;
    const dist = Math.round((state.radius * i) / RING_COUNT);
    ctx.fillText(String(dist), cx + ringR - 4, cy - 3);
  }

  // Compass letters — no line behind them (see GAP above). North is red (the
  // conventional heading reference); the rest are white.
  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ff4d4d";
  ctx.fillText("N", cx, cy - R + 11);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("S", cx, cy + R - 11);
  ctx.fillText("E", cx + R - 11, cy);
  ctx.fillText("W", cx - R + 11, cy);
}

// Static reference marker (no fade — only aircraft fade). Plotted from the
// optional marker coordinates at its bearing/distance from the radar center;
// skipped when unset or beyond the current radius.
function drawMarker(cx, cy, R) {
  const m = state.marker;
  if (!m) return;
  const dist = haversineKm(state.center.lat, state.center.lon, m.lat, m.lon);
  if (dist / state.radius > 1) return;
  const brg = bearingDeg(state.center.lat, state.center.lon, m.lat, m.lon);
  const r = (dist / state.radius) * R;
  const x = cx + r * Math.sin(toRad(brg));
  const y = cy - r * Math.cos(toRad(brg));

  ctx.save();
  ctx.globalAlpha = 0.5; // half visible
  ctx.strokeStyle = "#ffb300";
  ctx.fillStyle = "#ffb300";
  ctx.lineWidth = 1.5;
  const s = 7;
  ctx.beginPath(); // diamond outline
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath(); // center dot
  ctx.arc(x, y, 2, 0, TAU);
  ctx.fill();
  ctx.restore();
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
    ctx.font = "13px monospace";
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
  drawMarker(cx, cy, R);
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

// Round coordinate fields to 5 decimals once edited/pasted (the value sent on
// Update is rounded via readInputs/updateMarker regardless).
for (const input of [latInput, lonInput, markLatInput, markLonInput]) {
  input.addEventListener("change", () => normalizeCoord(input));
}

// Marker updates live as it's typed; cleared by emptying or the ✕ button.
for (const input of [markLatInput, markLonInput]) {
  input.addEventListener("input", () => {
    updateMarker();
    persistParams();
  });
}

markClearBtn.addEventListener("click", () => {
  markLatInput.value = "";
  markLonInput.value = "";
  updateMarker();
  persistParams();
});

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

// ----- Notification permission modal -----
const alertModal = document.getElementById("alert-modal");
document.getElementById("modal-enable").addEventListener("click", () => {
  soundEnabled = true;
  localStorage.setItem("soundEnabled", "true");
  updateSoundButton();
  getAudioCtx().resume?.(); // YES click = user gesture → AudioContext unlocks
  alertModal.classList.add("hidden");
});
document.getElementById("modal-dismiss").addEventListener("click", () => {
  soundEnabled = false;
  localStorage.setItem("soundEnabled", "false");
  updateSoundButton();
  alertModal.classList.add("hidden");
});

loadParams();
const initial = readInputs();
if (!Number.isNaN(initial.lat) && !Number.isNaN(initial.lon)) {
  state.center = { lat: initial.lat, lon: initial.lon };
}
if (!Number.isNaN(initial.radius)) state.radius = initial.radius;
updateMarker();

resizeCanvas();
updateMockButton();
updateSoundButton();
triggerUpdate();
requestAnimationFrame(frame);
