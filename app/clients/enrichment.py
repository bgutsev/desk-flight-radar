"""Aircraft metadata + route enrichment.

Given an aircraft, attach human-friendly metadata (registration/type/operator,
via hexdb.io) and the flight's origin/destination route. :class:`MockEnrichment`
serves canned data; :class:`HexDbEnrichment` calls the public APIs and degrades
gracefully (returning what it has) on any error.

For routes, hexdb's ``/route/icao/{callsign}`` is preferred because it tracks
the *current* flight (e.g. ``RYR1UN`` -> ``LIBD-LBSF``), unlike the static
callsign->route tables that are frequently stale for reused callsigns. When
hexdb has no route, adsbdb is used as a fallback so more flights get a route.

All lookups are cached in-memory so repeated polls of the same
aircraft/callsign/airport don't re-hit the API — keeping the endpoint fast and
easy on the upstream service.
"""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

import httpx

from app.clients.flight_source import Aircraft
from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

# Extra fields enrichment may add on top of the base Aircraft dict.
EnrichedAircraft = dict[str, object]

# Structured airport endpoint of a route (origin/destination).
Airport = dict[str, str]

# In-memory caches. ``None`` marks a known-miss so we don't retry every poll.
_meta_cache: dict[str, dict[str, str]] = {}  # icao24 -> registration/type/operator
_route_cache: dict[str, dict[str, Airport] | None] = {}  # callsign -> route
_airport_cache: dict[str, Airport | None] = {}  # ICAO -> airport fields

# ISO 3166-1 alpha-2 -> country name (common subset; falls back to the code).
_COUNTRY_NAMES: dict[str, str] = {
    "AE": "United Arab Emirates",
    "AL": "Albania",
    "AM": "Armenia",
    "AT": "Austria",
    "AZ": "Azerbaijan",
    "BA": "Bosnia and Herzegovina",
    "BE": "Belgium",
    "BG": "Bulgaria",
    "BH": "Bahrain",
    "BY": "Belarus",
    "CA": "Canada",
    "CH": "Switzerland",
    "CN": "China",
    "CY": "Cyprus",
    "CZ": "Czechia",
    "DE": "Germany",
    "DK": "Denmark",
    "EE": "Estonia",
    "EG": "Egypt",
    "ES": "Spain",
    "FI": "Finland",
    "FR": "France",
    "GB": "United Kingdom",
    "GE": "Georgia",
    "GR": "Greece",
    "HR": "Croatia",
    "HU": "Hungary",
    "IE": "Ireland",
    "IL": "Israel",
    "IN": "India",
    "IQ": "Iraq",
    "IR": "Iran",
    "IS": "Iceland",
    "IT": "Italy",
    "JO": "Jordan",
    "KW": "Kuwait",
    "LB": "Lebanon",
    "LT": "Lithuania",
    "LU": "Luxembourg",
    "LV": "Latvia",
    "MA": "Morocco",
    "MD": "Moldova",
    "ME": "Montenegro",
    "MK": "North Macedonia",
    "MT": "Malta",
    "NL": "Netherlands",
    "NO": "Norway",
    "PL": "Poland",
    "PT": "Portugal",
    "QA": "Qatar",
    "RO": "Romania",
    "RS": "Serbia",
    "RU": "Russia",
    "SA": "Saudi Arabia",
    "SE": "Sweden",
    "SI": "Slovenia",
    "SK": "Slovakia",
    "TN": "Tunisia",
    "TR": "Türkiye",
    "UA": "Ukraine",
    "US": "United States",
    "XK": "Kosovo",
    "AF": "Afghanistan",
    "AO": "Angola",
    "AR": "Argentina",
    "AU": "Australia",
    "BD": "Bangladesh",
    "BR": "Brazil",
    "CL": "Chile",
    "CM": "Cameroon",
    "CO": "Colombia",
    "DZ": "Algeria",
    "EC": "Ecuador",
    "ET": "Ethiopia",
    "GH": "Ghana",
    "HK": "Hong Kong",
    "ID": "Indonesia",
    "JP": "Japan",
    "KE": "Kenya",
    "KR": "South Korea",
    "KZ": "Kazakhstan",
    "LK": "Sri Lanka",
    "LY": "Libya",
    "MV": "Maldives",
    "MX": "Mexico",
    "MY": "Malaysia",
    "NG": "Nigeria",
    "NP": "Nepal",
    "NZ": "New Zealand",
    "OM": "Oman",
    "PE": "Peru",
    "PH": "Philippines",
    "PK": "Pakistan",
    "SD": "Sudan",
    "SG": "Singapore",
    "SY": "Syria",
    "TH": "Thailand",
    "TJ": "Tajikistan",
    "TM": "Turkmenistan",
    "TW": "Taiwan",
    "TZ": "Tanzania",
    "UG": "Uganda",
    "UZ": "Uzbekistan",
    "VN": "Vietnam",
    "YE": "Yemen",
    "ZA": "South Africa",
}


def _full_type_name(manufacturer: object, model: str) -> str:
    """Compose a human-friendly aircraft name from manufacturer + model.

    The manufacturer is prefixed only when present and the model doesn't already
    start with it, so "Airbus" + "A320 214" -> "Airbus A320 214" but "Boeing" +
    "Boeing 737" stays "Boeing 737".
    """
    model = model.strip()
    mfr = str(manufacturer or "").strip()
    if mfr and not model.lower().startswith(mfr.lower()):
        return f"{mfr} {model}"
    return model


def _adsbdb_airport(ap: dict) -> Airport:
    """Map an adsbdb airport object to {country, city, airport, code}."""
    return {
        "country": ap.get("country_name") or ap.get("country_iso_name") or "",
        "city": ap.get("municipality") or "",
        "airport": ap.get("name") or "",
        "code": ap.get("iata_code") or ap.get("icao_code") or "",
    }


def _with_cities(
    route: dict[str, Airport], source: dict[str, Airport] | None
) -> dict[str, Airport]:
    """Backfill each endpoint's city from ``source`` (matched by airport code).

    hexdb only exposes the region/province (e.g. "Mazowieckie"), not the city,
    so the real city ("Warsaw") is copied in from adsbdb's municipality where the
    two sources agree on the airport. New dicts are returned — the shared airport
    cache is not mutated.
    """
    if not source:
        return route
    cities = {
        ep["code"]: ep["city"]
        for ep in source.values()
        if ep.get("code") and ep.get("city")
    }
    return {
        side: {**ep, "city": cities.get(ep.get("code", "")) or ep.get("city", "")}
        for side, ep in route.items()
    }


@runtime_checkable
class EnrichmentClient(Protocol):
    """Anything that augments an aircraft record with metadata."""

    def enrich(self, aircraft: Aircraft) -> EnrichedAircraft: ...


# Minimal canned registry keyed by icao24, matching MockFlightSource output.
_MOCK_METADATA: dict[str, dict[str, str]] = {
    "4b1805": {
        "registration": "HB-JCA",
        "type_full": "Airbus A220-300",
        "operator": "Swiss",
    },
    "a1b2c3": {
        "registration": "D-AIMA",
        "type_full": "Airbus A380-800",
        "operator": "Lufthansa",
    },
    # The two time-driven mocks (takeoff/landing) so they also show a full name.
    "c0ffee": {
        "registration": "EI-DKL",
        "type_full": "Airbus A320-200",
        "operator": "Ryanair",
    },
    "1a4d09": {
        "registration": "G-TUIA",
        "type_full": "Boeing 737-800",
        "operator": "TUI Airways",
    },
}

# Canned routes for the mock aircraft (no network in mock mode).
_MOCK_ROUTES: dict[str, dict[str, Airport]] = {
    "4b1805": {
        "origin": {
            "country": "Switzerland",
            "city": "Zürich",
            "airport": "Zürich Airport",
            "code": "ZRH",
        },
        "destination": {
            "country": "Bulgaria",
            "city": "Sofia",
            "airport": "Sofia Airport",
            "code": "SOF",
        },
    },
    "a1b2c3": {
        "origin": {
            "country": "Germany",
            "city": "Frankfurt am Main",
            "airport": "Frankfurt Airport",
            "code": "FRA",
        },
        "destination": {
            "country": "Bulgaria",
            "city": "Sofia",
            "airport": "Sofia Airport",
            "code": "SOF",
        },
    },
}


class MockEnrichment:
    """Attach canned metadata and routes for known mock aircraft."""

    def enrich(self, aircraft: Aircraft) -> EnrichedAircraft:
        enriched: EnrichedAircraft = dict(aircraft)
        enriched.update(_MOCK_METADATA.get(aircraft["icao24"], {}))
        route = _MOCK_ROUTES.get(aircraft["icao24"])
        if route:
            enriched["origin"] = route["origin"]
            enriched["destination"] = route["destination"]
        return enriched


class HexDbEnrichment:
    """Metadata + route lookups via hexdb.io, cached and resilient.

    On any network or parsing error the affected lookup is skipped, so the
    caller always gets a usable record.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    def enrich(self, aircraft: Aircraft) -> EnrichedAircraft:
        enriched: EnrichedAircraft = dict(aircraft)
        meta = self._metadata(aircraft["icao24"])
        enriched.update(meta)
        route = self._route(aircraft["callsign"])
        if route:
            enriched["origin"] = route["origin"]
            enriched["destination"] = route["destination"]
        return enriched

    def _metadata(self, icao24: str) -> dict[str, str]:
        if not icao24:
            return {}
        if icao24 in _meta_cache:
            return _meta_cache[icao24]
        meta: dict[str, str] = {}
        try:
            url = f"{self._settings.enrichment_base_url}/aircraft/{icao24}"
            resp = httpx.get(url, timeout=self._settings.request_timeout_s)
            # 404 simply means "not in the database" — a normal miss, not an error.
            if resp.status_code == 200:
                body = resp.json()
                if body.get("Registration"):
                    meta["registration"] = body["Registration"]
                if body.get("Type"):
                    # Full aircraft name (manufacturer + model) for the card, kept
                    # separate from the short ICAO ``type`` code shown on the radar.
                    # hexdb's ``Type`` is just the model ("A320 214"), so the
                    # manufacturer is prefixed unless the model already starts with it.
                    meta["type_full"] = _full_type_name(
                        body.get("Manufacturer"), body["Type"]
                    )
                if body.get("RegisteredOwners"):
                    meta["operator"] = body["RegisteredOwners"]
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("hexdb lookup failed for %s (%s)", icao24, exc)
        _meta_cache[icao24] = meta
        return meta

    def _route(self, callsign: str) -> dict[str, Airport] | None:
        """Resolve the flight's origin/destination, cached per callsign.

        The callsign is a unique identifier and is used **exactly as broadcast**
        — never altered. hexdb's ``/route/icao/{callsign}`` (current flight) is
        tried first; if it has nothing, adsbdb is used as a fallback. If neither
        knows this exact callsign, no route is returned.
        """
        if not callsign:
            return None
        if callsign in _route_cache:
            return _route_cache[callsign]

        route = self._hexdb_route(callsign)
        if route is None:
            route = self._adsbdb_route(callsign)
        else:
            # hexdb gives the province, not the city — backfill the real city
            # from adsbdb's municipality where the airports match by code.
            route = _with_cities(route, self._adsbdb_route(callsign))

        _route_cache[callsign] = route
        return route

    def _hexdb_route(self, callsign: str) -> dict[str, Airport] | None:
        """hexdb route -> ICAO codes -> hexdb airport fields."""
        try:
            url = f"{self._settings.enrichment_base_url}/route/icao/{callsign}"
            resp = httpx.get(url, timeout=self._settings.request_timeout_s)
            if resp.status_code == 200:
                codes = [c for c in (resp.json().get("route") or "").split("-") if c]
                if len(codes) >= 2:
                    origin = self._airport(codes[0])
                    destination = self._airport(codes[-1])
                    if origin and destination:
                        return {"origin": origin, "destination": destination}
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("hexdb route lookup failed for %s (%s)", callsign, exc)
        return None

    def _adsbdb_route(self, callsign: str) -> dict[str, Airport] | None:
        """adsbdb flightroute -> rich origin/destination airport fields."""
        try:
            url = f"{self._settings.adsbdb_base_url}/callsign/{callsign}"
            resp = httpx.get(url, timeout=self._settings.request_timeout_s)
            if resp.status_code == 200:
                fr = (resp.json().get("response") or {}).get("flightroute") or {}
                origin = fr.get("origin")
                destination = fr.get("destination")
                if origin and destination:
                    return {
                        "origin": _adsbdb_airport(origin),
                        "destination": _adsbdb_airport(destination),
                    }
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("adsbdb route lookup failed for %s (%s)", callsign, exc)
        return None

    def _airport(self, icao: str) -> Airport | None:
        """Resolve an ICAO code to {country, city, airport, code} via hexdb."""
        if not icao:
            return None
        if icao in _airport_cache:
            return _airport_cache[icao]
        airport: Airport | None = None
        try:
            url = f"{self._settings.enrichment_base_url}/airport/icao/{icao}"
            resp = httpx.get(url, timeout=self._settings.request_timeout_s)
            if resp.status_code == 200:
                body = resp.json()
                country = body.get("country_code") or ""
                airport = {
                    "country": _COUNTRY_NAMES.get(country, country),
                    "city": body.get("region_name") or "",
                    "airport": body.get("airport") or "",
                    "code": body.get("iata") or icao,
                }
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("hexdb airport lookup failed for %s (%s)", icao, exc)
        _airport_cache[icao] = airport
        return airport


def get_enrichment_client(mock: bool) -> EnrichmentClient:
    """Select an enrichment implementation based on the ``mock`` flag."""

    return MockEnrichment() if mock else HexDbEnrichment()
