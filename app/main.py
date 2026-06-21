"""FastAPI application and HTTP endpoints for Plane Radar."""

from __future__ import annotations

from typing import Annotated

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from app.classifier import classify
from app.clients.enrichment import get_enrichment_client
from app.clients.flight_source import get_flight_source
from app.config import get_settings
from app.utils.geo import is_within_radius

settings = get_settings()
app = FastAPI(title=settings.app_title)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/aircraft")
def get_aircraft(
    lat: Annotated[float, Query(ge=-90, le=90)],
    lon: Annotated[float, Query(ge=-180, le=180)],
    radius_km: Annotated[float, Query(gt=0, le=500)],
    mock: bool = False,
) -> dict[str, object]:
    flight_source = get_flight_source(mock)
    enrichment = get_enrichment_client(mock)

    try:
        states = flight_source.get_states(lat, lon, radius_km)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Flight data source returned {exc.response.status_code}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not reach flight data source: {exc}",
        ) from exc

    aircraft: list[dict[str, object]] = []
    for state in states:
        if not is_within_radius(
            lat, lon, state["latitude"], state["longitude"], radius_km
        ):
            continue
        enriched = enrichment.enrich(state)
        enriched["classification"] = classify(state, lat, lon)
        aircraft.append(enriched)

    return {
        "center": {
            "lat": lat,
            "lon": lon,
        },
        "radius_km": radius_km,
        "mock": mock,
        "aircraft": aircraft,
    }


# Mounted last so the API routes above take precedence. ``html=True`` serves
# static/index.html at ``/`` and other assets (radar-frame.png, css, js) by path.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
