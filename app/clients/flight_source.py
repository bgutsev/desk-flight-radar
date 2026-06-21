"""Flight state sources (ADS-B).

Defines the :class:`FlightSource` protocol plus two implementations:

* :class:`MockFlightSource` — deterministic canned traffic around the query
  center, used for development and tests.
* :class:`AdsbFiFlightSource` — live ADS-B states from adsb.fi. No API key or
  rate-limit constraints.
"""

from __future__ import annotations

import logging
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
    velocity_kmh: float
    heading_deg: float


@runtime_checkable
class FlightSource(Protocol):
    """Anything that can return aircraft states near a center point."""

    def get_states(
        self, lat: float, lon: float, radius_km: float
    ) -> list[Aircraft]: ...


class MockFlightSource:
    """Returns two deterministic aircraft offset from the query center.

    The offsets place both aircraft ~9–13 km from the center so they survive a
    typical radius filter.
    """

    def get_states(self, lat: float, lon: float, radius_km: float) -> list[Aircraft]:
        return [
            Aircraft(
                icao24="4b1805",
                callsign="SWR123",
                type="BCS3",
                latitude=lat + 0.08,
                longitude=lon - 0.05,
                altitude_m=11280,
                velocity_kmh=835,
                heading_deg=92,
            ),
            Aircraft(
                icao24="a1b2c3",
                callsign="DLH456",
                type="A388",
                latitude=lat - 0.12,
                longitude=lon + 0.09,
                altitude_m=9750,
                velocity_kmh=790,
                heading_deg=244,
            ),
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
                velocity_kmh=float(ac.get("gs") or 0.0) * _KM_PER_NM,
                heading_deg=float(ac.get("track") or 0.0),
            )
        )
    return results


def get_flight_source(mock: bool) -> FlightSource:
    """Select a flight source implementation based on the ``mock`` flag."""

    return MockFlightSource() if mock else AdsbFiFlightSource()
