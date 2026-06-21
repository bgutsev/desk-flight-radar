"""Aircraft metadata enrichment.

Given an aircraft's ``icao24`` hex, attach human-friendly metadata such as
registration, type, and operator. :class:`MockEnrichment` serves canned data;
:class:`HexDbEnrichment` calls the hexdb.io public API and degrades gracefully
(returns the aircraft unchanged) when the lookup fails.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import httpx

from app.clients.flight_source import Aircraft
from app.config import Settings, get_settings

# Extra fields enrichment may add on top of the base Aircraft dict.
EnrichedAircraft = dict[str, object]


@runtime_checkable
class EnrichmentClient(Protocol):
    """Anything that augments an aircraft record with metadata."""

    def enrich(self, aircraft: Aircraft) -> EnrichedAircraft: ...


# Minimal canned registry keyed by icao24, matching MockFlightSource output.
_MOCK_METADATA: dict[str, dict[str, str]] = {
    "4b1805": {
        "registration": "HB-JCA",
        "type": "Airbus A220-300",
        "operator": "Swiss",
    },
    "a1b2c3": {
        "registration": "D-AIMA",
        "type": "Airbus A380-800",
        "operator": "Lufthansa",
    },
}


class MockEnrichment:
    """Attach canned metadata for known mock aircraft."""

    def enrich(self, aircraft: Aircraft) -> EnrichedAircraft:
        enriched: EnrichedAircraft = dict(aircraft)
        enriched.update(_MOCK_METADATA.get(aircraft["icao24"], {}))
        return enriched


class HexDbEnrichment:
    """Metadata lookup via the hexdb.io public API.

    On any network or parsing error the method returns the aircraft dict
    unchanged so the caller always gets a usable record.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    def enrich(self, aircraft: Aircraft) -> EnrichedAircraft:
        enriched: EnrichedAircraft = dict(aircraft)
        try:
            url = f"{self._settings.enrichment_base_url}/aircraft/{aircraft['icao24']}"
            resp = httpx.get(url, timeout=self._settings.request_timeout_s)
            resp.raise_for_status()
            meta = resp.json()
            # hexdb.io field names use PascalCase.
            if meta.get("Registration"):
                enriched["registration"] = meta["Registration"]
            if meta.get("Type"):
                enriched["type"] = meta["Type"]
            if meta.get("RegisteredOwners"):
                enriched["operator"] = meta["RegisteredOwners"]
        except (httpx.HTTPError, Exception):
            pass
        return enriched


def get_enrichment_client(mock: bool) -> EnrichmentClient:
    """Select an enrichment implementation based on the ``mock`` flag."""

    return MockEnrichment() if mock else HexDbEnrichment()
