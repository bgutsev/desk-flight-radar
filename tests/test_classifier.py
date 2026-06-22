from app.classifier import classify

CENTER_LAT = 42.6977
CENTER_LON = 23.3219


def _aircraft(
    lat: float,
    lon: float,
    heading: float,
    altitude: float,
    vertical_rate: float = 0.0,
    velocity: float = 700.0,
) -> dict:
    return {
        "icao24": "test01",
        "callsign": "TST001",
        "latitude": lat,
        "longitude": lon,
        "altitude_m": altitude,
        "vertical_rate_fpm": vertical_rate,
        "velocity_kmh": velocity,
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


def test_landing_sequence_until_stopped() -> None:
    # A single aircraft tracked north of the field, nose pointing south toward
    # the runway, descending until it touches down and rolls to a full stop.
    # Each tuple is (phase, altitude_m, vertical_rate_fpm, velocity_kmh, expected).
    # The default center elevation is 465 m, so the ground band is 455-475 m.
    profile = [
        ("inbound cruise descent", 3000.0, -1200.0, 700.0, "arriving"),
        ("intermediate approach", 1500.0, -1000.0, 500.0, "arriving"),
        ("final approach", 600.0, -800.0, 380.0, "arriving"),
        ("flare into ground band", 472.0, -200.0, 300.0, "ground"),
        ("touchdown", 466.0, 0.0, 240.0, "ground"),
        ("rollout braking", 465.0, 0.0, 90.0, "ground"),
        ("full stop on tarmac", 465.0, 0.0, 0.0, "ground"),
    ]

    for phase, altitude, vr, velocity, expected in profile:
        aircraft = _aircraft(
            CENTER_LAT + 0.1,
            CENTER_LON,
            heading=180.0,
            altitude=altitude,
            vertical_rate=vr,
            velocity=velocity,
        )
        result = classify(aircraft, CENTER_LAT, CENTER_LON)
        assert result == expected, f"{phase}: expected {expected}, got {result}"


def test_takeoff_sequence_until_airborne() -> None:
    # The mirror of the landing case: an aircraft sitting on the runway, rolling,
    # rotating, then climbing out, nose pointing south away from the field.
    # Each tuple is (phase, altitude_m, vertical_rate_fpm, velocity_kmh, expected).
    # The default center elevation is 465 m, so the ground band is 455-475 m: an
    # aircraft reads "ground" until it climbs clear of that band, regardless of
    # how fast it is already climbing.
    profile = [
        ("holding on runway", 465.0, 0.0, 0.0, "ground"),
        ("takeoff roll", 465.0, 0.0, 150.0, "ground"),
        ("rotation in ground band", 472.0, 600.0, 280.0, "ground"),
        ("initial climb", 600.0, 1800.0, 320.0, "departing"),
        ("climb out", 1500.0, 2000.0, 420.0, "departing"),
        ("en route climb", 3000.0, 1500.0, 500.0, "departing"),
    ]

    for phase, altitude, vr, velocity, expected in profile:
        aircraft = _aircraft(
            CENTER_LAT + 0.1,
            CENTER_LON,
            heading=0.0,
            altitude=altitude,
            vertical_rate=vr,
            velocity=velocity,
        )
        result = classify(aircraft, CENTER_LAT, CENTER_LON)
        assert result == expected, f"{phase}: expected {expected}, got {result}"
