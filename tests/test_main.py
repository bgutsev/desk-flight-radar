from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)

ALLOWED_CLASSIFICATIONS = {"arriving", "departing", "cruising"}


def test_health_returns_status_ok() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_aircraft_returns_mock_aircraft_near_center() -> None:
    response = client.get(
        "/aircraft",
        params={
            "lat": 42.6977,
            "lon": 23.3219,
            "radius_km": 50,
            "mock": True,
        },
    )

    assert response.status_code == 200

    data = response.json()
    assert data["center"] == {"lat": 42.6977, "lon": 23.3219}
    assert data["radius_km"] == 50
    assert data["mock"] is True
    assert isinstance(data["aircraft"], list)
    assert len(data["aircraft"]) > 0


def test_aircraft_each_have_classification() -> None:
    response = client.get(
        "/aircraft",
        params={"lat": 42.6977, "lon": 23.3219, "radius_km": 50, "mock": True},
    )

    data = response.json()
    for aircraft in data["aircraft"]:
        assert aircraft["classification"] in ALLOWED_CLASSIFICATIONS


def test_aircraft_non_mock_parses_adsb_fi_response() -> None:
    # adsb.fi JSON object for a single aircraft.
    fake_ac = {
        "hex": "ab1234",
        "flight": "TST001 ",
        "lat": 42.6977,
        "lon": 23.3219,
        "alt_baro": 13123,  # feet → 13123 * 0.3048 ≈ 4000 m
        "gs": 216,  # knots → 216 * 1.852 ≈ 400 km/h
        "track": 270.0,
    }
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"aircraft": [fake_ac], "resultCount": 1}

    with patch("app.clients.flight_source.httpx.get", return_value=mock_resp):
        response = client.get(
            "/aircraft",
            params={"lat": 42.6977, "lon": 23.3219, "radius_km": 50, "mock": False},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["mock"] is False
    assert len(data["aircraft"]) == 1
    ac = data["aircraft"][0]
    assert ac["icao24"] == "ab1234"
    assert ac["callsign"] == "TST001"
    assert ac["altitude_m"] == pytest.approx(13123 * 0.3048, rel=1e-3)
    assert ac["velocity_kmh"] == pytest.approx(216 * 1.852, rel=1e-3)
    assert ac["classification"] in ALLOWED_CLASSIFICATIONS
