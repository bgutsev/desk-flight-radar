from app.classifier import classify

CENTER_LAT = 42.6977
CENTER_LON = 23.3219


def _aircraft(lat: float, lon: float, heading: float, altitude: float) -> dict:
    return {
        "icao24": "test01",
        "callsign": "TST001",
        "latitude": lat,
        "longitude": lon,
        "altitude_m": altitude,
        "velocity_kmh": 700,
        "heading_deg": heading,
    }


def test_heading_toward_center_is_arriving() -> None:
    # North of center, nose pointing south (toward center).
    aircraft = _aircraft(CENTER_LAT + 0.1, CENTER_LON, heading=180.0, altitude=3000.0)
    assert classify(aircraft, CENTER_LAT, CENTER_LON) == "arriving"


def test_heading_away_from_center_is_departing() -> None:
    # North of center, nose pointing north (away from center).
    aircraft = _aircraft(CENTER_LAT + 0.1, CENTER_LON, heading=0.0, altitude=3000.0)
    assert classify(aircraft, CENTER_LAT, CENTER_LON) == "departing"


def test_high_altitude_is_cruising() -> None:
    # Heading toward center but well above the cruise threshold.
    aircraft = _aircraft(CENTER_LAT + 0.1, CENTER_LON, heading=180.0, altitude=12000.0)
    assert classify(aircraft, CENTER_LAT, CENTER_LON) == "cruising"
