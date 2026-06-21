"""Application configuration sourced from environment variables.

Kept dependency-free on purpose: a frozen dataclass read from ``os.getenv`` is
enough here and avoids pulling in ``pydantic-settings``. ``get_settings()`` is
cached so the rest of the app shares a single immutable ``Settings`` instance.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


def _get_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _get_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    """Immutable runtime configuration."""

    app_title: str = "Plane Radar API"
    default_mock: bool = False
    request_timeout_s: float = 10.0

    # Flight source (adsb.fi).
    adsb_fi_base_url: str = "https://opendata.adsb.fi/api/v2"

    # Aircraft enrichment + primary route lookup (hexdb.io).
    enrichment_base_url: str = "https://hexdb.io/api/v1"

    # Fallback route lookup when hexdb has no route (adsbdb.com).
    adsbdb_base_url: str = "https://api.adsbdb.com/v0"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide :class:`Settings` singleton."""

    return Settings(
        app_title=os.getenv("APP_TITLE", "Plane Radar API"),
        default_mock=_get_bool("DEFAULT_MOCK", False),
        request_timeout_s=_get_float("REQUEST_TIMEOUT_S", 10.0),
        adsb_fi_base_url=os.getenv(
            "ADSB_FI_BASE_URL", "https://opendata.adsb.fi/api/v2"
        ),
        enrichment_base_url=os.getenv("ENRICHMENT_BASE_URL", "https://hexdb.io/api/v1"),
        adsbdb_base_url=os.getenv("ADSBDB_BASE_URL", "https://api.adsbdb.com/v0"),
    )
