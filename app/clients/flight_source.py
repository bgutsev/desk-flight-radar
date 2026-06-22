"""Flight state sources (ADS-B).

Defines the :class:`FlightSource` protocol plus two implementations:

* :class:`MockFlightSource` — deterministic canned traffic around the query
  center, used for development and tests.
* :class:`AdsbFiFlightSource` — live ADS-B states from adsb.fi. No API key or
  rate-limit constraints.
"""

from __future__ import annotations

import logging
import time
from typing import Protocol, TypedDict, runtime_checkable

import httpx

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

_KM_PER_NM = 1.852
_FT_PER_M = 0.3048

# Last successful adsb.fi result per query signature, used as a fallback when
# the upstream API errors or times out. Keyed by (lat, lon, radius_km).
_last_success: dict[tuple[float, float, float], list["Aircraft"]] = {}


class Aircraft(TypedDict):
    """Normalised aircraft state shared across the app."""

    icao24: str
    callsign: str
    type: str
    latitude: float
    longitude: float
    altitude_m: float
    vertical_rate_fpm: float  # ft/min; positive = climbing, negative = descending
    velocity_kmh: float
    heading_deg: float


@runtime_checkable
class FlightSource(Protocol):
    """Anything that can return aircraft states near a center point."""

    def get_states(
        self, lat: float, lon: float, radius_km: float
    ) -> list[Aircraft]: ...


# Takeoff mock cycle: the aircraft sits on the runway, then lifts off and
# climbs out, looping forever so the ground→airborne transition (which the
# frontend latches as "departing") can be observed repeatedly.
_TAKEOFF_GROUND_S = 8.0  # seconds parked on the runway at the start of each cycle
_TAKEOFF_CLIMB_S = 32.0  # seconds spent climbing out before the cycle restarts
_TAKEOFF_PERIOD_S = _TAKEOFF_GROUND_S + _TAKEOFF_CLIMB_S
_TAKEOFF_TOP_ALT_M = 3000.0  # altitude reached at the end of the climb
_TAKEOFF_LON_SPREAD = 0.08  # degrees of eastward drift across the climb


def _mock_takeoff(lat: float, lon: float, now: float) -> Aircraft:
    """A single aircraft cycling through ground → liftoff → climb-out.

    Phase is derived from wall-clock time so successive polls see it move, which
    is what triggers the frontend's ground-origin "departing" latch (a static
    snapshot could never exercise it). It starts on the runway at the center.
    """
    phase = now % _TAKEOFF_PERIOD_S
    if phase < _TAKEOFF_GROUND_S:
        # Parked on the runway: ADS-B "ground" → 0 m, no climb, taxi speed.
        return Aircraft(
            icao24="c0ffee",
            callsign="TKO000",
            type="A320",
            latitude=lat,
            longitude=lon,
            altitude_m=0.0,
            vertical_rate_fpm=0.0,
            velocity_kmh=30,
            heading_deg=90,
        )
    # Climbing out: altitude and eastward distance grow with progress.
    progress = (phase - _TAKEOFF_GROUND_S) / _TAKEOFF_CLIMB_S
    return Aircraft(
        icao24="c0ffee",
        callsign="TKO000",
        type="A320",
        latitude=lat,
        longitude=lon + progress * _TAKEOFF_LON_SPREAD,
        altitude_m=progress * _TAKEOFF_TOP_ALT_M,
        vertical_rate_fpm=2000,  # climbing → departing
        velocity_kmh=150 + progress * 250,
        heading_deg=90,
    )


# Landing mock cycle: the mirror of the takeoff — the aircraft descends on
# approach from the west, touches down, sits briefly, then loops back out to a
# fresh approach so the airborne→ground (landing) transition can be observed.
_LANDING_APPROACH_S = 32.0  # seconds descending on approach toward the field
_LANDING_GROUND_S = 8.0  # seconds parked after touchdown before the cycle restarts
_LANDING_PERIOD_S = _LANDING_APPROACH_S + _LANDING_GROUND_S
_LANDING_TOP_ALT_M = 3000.0  # altitude at the start of the approach
_LANDING_LON_SPREAD = 0.08  # degrees of westward offset at the start of the approach


def _mock_landing(lat: float, lon: float, now: float) -> Aircraft:
    """A single aircraft cycling through approach → touchdown → parked.

    The time-driven mirror of :func:`_mock_takeoff`: it descends toward the
    center, lands, then restarts, so the landing transition can be tested.
    """
    phase = now % _LANDING_PERIOD_S
    if phase >= _LANDING_APPROACH_S:
        # Parked on the runway after landing: ADS-B "ground" → 0 m, taxi speed.
        return Aircraft(
            icao24="1a4d09",
            callsign="LND999",
            type="B738",
            latitude=lat,
            longitude=lon,
            altitude_m=0.0,
            vertical_rate_fpm=0.0,
            velocity_kmh=30,
            heading_deg=90,
        )
    # On approach: altitude and westward distance shrink as the plane nears the
    # field. ``remaining`` is 1 at the start of the approach and 0 at touchdown.
    remaining = 1.0 - phase / _LANDING_APPROACH_S
    return Aircraft(
        icao24="1a4d09",
        callsign="LND999",
        type="B738",
        latitude=lat,
        longitude=lon - remaining * _LANDING_LON_SPREAD,
        altitude_m=remaining * _LANDING_TOP_ALT_M,
        vertical_rate_fpm=-1500,  # descending → arriving
        velocity_kmh=160 + remaining * 200,
        heading_deg=90,  # heading east toward the field from the west
    )


class MockFlightSource:
    """Returns deterministic aircraft offset from the query center.

    Two aircraft (an arrival and a departure) sit ~9–13 km out so they survive a
    typical radius filter, plus two time-driven aircraft that cycle through a
    takeoff (ground → liftoff → climb-out) and a landing (approach → touchdown →
    parked) so both transitions can be tested in mock mode.
    """

    def get_states(self, lat: float, lon: float, radius_km: float) -> list[Aircraft]:
        return [
            Aircraft(
                icao24="4b1805",
                callsign="SWR123",
                type="BCS3",
                latitude=lat + 0.08,
                longitude=lon - 0.05,
                altitude_m=2400,  # on approach
                vertical_rate_fpm=-900,  # descending → arriving
                velocity_kmh=320,
                heading_deg=210,
            ),
            Aircraft(
                icao24="a1b2c3",
                callsign="DLH456",
                type="A388",
                latitude=lat - 0.12,
                longitude=lon + 0.09,
                altitude_m=3100,  # just departed
                vertical_rate_fpm=1800,  # climbing → departing
                velocity_kmh=410,
                heading_deg=244,
            ),
            _mock_takeoff(lat, lon, time.monotonic()),
            _mock_landing(lat, lon, time.monotonic()),
        ]


def _parse_altitude_m(raw: object) -> float:
    """Convert an adsb.fi alt_baro value (feet or 'ground') to metres."""
    if raw is None or raw == "ground":
        return 0.0
    return float(raw) * _FT_PER_M


class AdsbFiFlightSource:
    """Live ADS-B states from the adsb.fi public API.

    Endpoint: ``GET /api/v2/lat/{lat}/lon/{lon}/dist/{dist_nm}``
    The ``dist`` path segment is in nautical miles; ``radius_km`` is converted
    automatically.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    def get_states(self, lat: float, lon: float, radius_km: float) -> list[Aircraft]:
        dist_nm = radius_km / _KM_PER_NM
        url = f"{self._settings.adsb_fi_base_url}/lat/{lat}/lon/{lon}/dist/{dist_nm}"
        key = (round(lat, 4), round(lon, 4), round(radius_km, 1))

        try:
            resp = httpx.get(url, timeout=self._settings.request_timeout_s)
            resp.raise_for_status()
            results = _parse_states(resp.json())
        except (httpx.HTTPStatusError, httpx.RequestError) as exc:
            # Never surface upstream failures (502/429/timeouts) to the client —
            # serve the last good data for this query, or an empty list.
            cached = _last_success.get(key, [])
            logger.warning(
                "adsb.fi request failed (%s); serving %s",
                exc,
                f"{len(cached)} cached aircraft" if cached else "empty list",
            )
            return cached

        _last_success[key] = results
        return results


def _parse_states(payload: object) -> list[Aircraft]:
    """Map an adsb.fi JSON payload into the normalised Aircraft list."""
    results: list[Aircraft] = []
    aircraft = payload.get("aircraft") if isinstance(payload, dict) else None
    for ac in aircraft or []:
        lat_val = ac.get("lat")
        lon_val = ac.get("lon")
        if lat_val is None or lon_val is None:
            continue
        results.append(
            Aircraft(
                icao24=ac.get("hex") or "",
                callsign=(ac.get("flight") or "").strip(),
                type=(ac.get("t") or "").strip(),
                latitude=float(lat_val),
                longitude=float(lon_val),
                altitude_m=_parse_altitude_m(ac.get("alt_baro")),
                vertical_rate_fpm=float(ac.get("baro_rate") or 0.0),
                velocity_kmh=float(ac.get("gs") or 0.0) * _KM_PER_NM,
                heading_deg=float(ac.get("track") or 0.0),
            )
        )
    return results


def get_flight_source(mock: bool) -> FlightSource:
    """Select a flight source implementation based on the ``mock`` flag."""

    return MockFlightSource() if mock else AdsbFiFlightSource()
