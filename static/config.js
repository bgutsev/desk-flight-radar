"use strict";

/**
 * Plane Radar — user-editable configuration.
 *
 * These are the default application settings. Edit the values below and reload
 * the page; no build step is required. Saved Lat/Lon/Radius in the browser
 * (localStorage) override the defaults on subsequent visits.
 */
window.RADAR_CONFIG = {
  // Default map centre — Sofia Airport (LBSF / SOF). Used only on first visit.
  DEFAULT_LAT: 42.6967,
  DEFAULT_LON: 23.4167,
  DEFAULT_RADIUS_KM: 25,

  // How often the aircraft list is refreshed, in milliseconds.
  FETCH_INTERVAL_MS: 2000,

  // Radar sweep speed (radians per second) and number of range rings.
  SWEEP_SPEED: 2.0,
  RING_COUNT: 4,

  // "Landing nearby" notification fires within this fraction of the radius.
  NEARBY_FRACTION: 1 / 3,
};
