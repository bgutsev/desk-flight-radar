from unittest.mock import MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

import app.clients.flight_source as flight_source
from app.main import app


client = TestClient(app)

ALLOWED_CLASSIFICATIONS = {"arriving", "departing", "cruising", "ground"}


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
        "t": "A332",
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
    assert ac["type"] == "A332"
    assert ac["altitude_m"] == pytest.approx(13123 * 0.3048, rel=1e-3)
    assert ac["velocity_kmh"] == pytest.approx(216 * 1.852, rel=1e-3)
    assert ac["classification"] in ALLOWED_CLASSIFICATIONS


def test_aircraft_upstream_failure_returns_empty_when_no_cache() -> None:
    flight_source._last_success.clear()

    with patch(
        "app.clients.flight_source.httpx.get",
        side_effect=httpx.ConnectTimeout("timeout"),
    ):
        response = client.get(
            "/aircraft",
            params={"lat": 1.0, "lon": 1.0, "radius_km": 50, "mock": False},
        )

    # No 502 — a failed upstream with an empty cache yields an empty list.
    assert response.status_code == 200
    assert response.json()["aircraft"] == []


def test_aircraft_upstream_failure_serves_cached_data() -> None:
    flight_source._last_success.clear()
    params = {"lat": 41.0, "lon": 24.0, "radius_km": 50, "mock": False}
    fake_ac = {
        "hex": "cafe01",
        "flight": "CACHE1",
        "t": "B738",
        "lat": 41.0,
        "lon": 24.0,
        "alt_baro": 10000,
        "gs": 300,
        "track": 90.0,
    }
    ok = MagicMock()
    ok.json.return_value = {"aircraft": [fake_ac]}

    # First call succeeds and populates the cache.
    with patch("app.clients.flight_source.httpx.get", return_value=ok):
        first = client.get("/aircraft", params=params)
    assert len(first.json()["aircraft"]) == 1

    # Second call fails upstream but serves the cached aircraft (no 502).
    with patch(
        "app.clients.flight_source.httpx.get",
        side_effect=httpx.ReadTimeout("timeout"),
    ):
        second = client.get("/aircraft", params=params)

    assert second.status_code == 200
    cached = second.json()["aircraft"]
    assert len(cached) == 1
    assert cached[0]["icao24"] == "cafe01"


def test_mock_aircraft_include_route() -> None:
    response = client.get(
        "/aircraft",
        params={"lat": 42.6977, "lon": 23.3219, "radius_km": 50, "mock": True},
    )

    data = response.json()
    swr = next(a for a in data["aircraft"] if a["icao24"] == "4b1805")
    assert swr["origin"]["code"] == "ZRH"
    assert swr["destination"]["code"] == "SOF"
    # All four fields are present for formatting "Country / City / Airport (code)".
    for field in ("country", "city", "airport", "code"):
        assert swr["origin"][field]
        assert swr["destination"][field]


def test_hexdb_route_enrichment_resolves_current_route() -> None:
    import app.clients.enrichment as enrichment

    enrichment._route_cache.clear()
    enrichment._airport_cache.clear()
    enrichment._meta_cache.clear()

    def fake_get(url, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        if "/route/icao/" in url:
            resp.json.return_value = {"flight": "RYR1UN", "route": "LIBD-LBSF"}
        elif "/airport/icao/LIBD" in url:
            resp.json.return_value = {
                "country_code": "IT",
                "region_name": "Puglia",
                "iata": "BRI",
                "airport": "Bari Karol Wojtyla Airport",
            }
        elif "/airport/icao/LBSF" in url:
            resp.json.return_value = {
                "country_code": "BG",
                "region_name": "Sofia",
                "iata": "SOF",
                "airport": "Sofia Airport",
            }
        else:  # /aircraft/<icao> metadata — none for this test
            resp.json.return_value = {}
        return resp

    aircraft = {
        "icao24": "abc123",
        "callsign": "RYR1UN",
        "type": "B738",
        "latitude": 42.0,
        "longitude": 23.0,
        "altitude_m": 3000.0,
        "velocity_kmh": 700.0,
        "heading_deg": 0.0,
    }
    with patch("app.clients.enrichment.httpx.get", side_effect=fake_get):
        out = enrichment.HexDbEnrichment().enrich(aircraft)  # type: ignore[arg-type]

    assert out["origin"]["code"] == "BRI"
    assert out["origin"]["country"] == "Italy"
    assert out["destination"]["code"] == "SOF"
    assert out["destination"]["airport"] == "Sofia Airport"


def test_root_serves_radar_ui() -> None:
    response = client.get("/")

    assert response.status_code == 200
    assert "<canvas" in response.text
    assert "radar.js" in response.text


def test_static_assets_served() -> None:
    for path in ("/style.css", "/radar.js", "/radar-frame.png"):
        response = client.get(path)
        assert response.status_code == 200, path
