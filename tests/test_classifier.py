from app.classifier import classify, estimate_field_elevation

CENTER_LAT = 42.6977
CENTER_LON = 23.3219
FIELD_ELEV_M = 531.0  # Sofia-like seed; the ground band is FIELD_ELEV_M ± 30 m.


def _aircraft(
    altitude_geom_m: float,
    vertical_rate: float = 0.0,
    on_ground: bool = False,
    lat: float = CENTER_LAT + 0.1,
    lon: float = CENTER_LON,
    heading: float = 0.0,
    velocity: float = 700.0,
) -> dict:
    return {
        "icao24": "test01",
        "callsign": "TST001",
        "latitude": lat,
        "longitude": lon,
        "altitude_m": altitude_geom_m,
        "altitude_geom_m": altitude_geom_m,
        "vertical_rate_fpm": vertical_rate,
        "geom_rate_fpm": vertical_rate,
        "velocity_kmh": velocity,
        "heading_deg": heading,
        "on_ground": on_ground,
    }


def test_ground_bit_is_ground() -> None:
    # The ADS-B air/ground bit is authoritative regardless of altitude noise.
    aircraft = _aircraft(altitude_geom_m=0.0, on_ground=True)
    assert classify(aircraft, FIELD_ELEV_M) == "ground"


def test_near_field_geom_is_ground() -> None:
    # Within the geometric ground band of the field and not climbing.
    aircraft = _aircraft(altitude_geom_m=FIELD_ELEV_M + 15.0, vertical_rate=0.0)
    assert classify(aircraft, FIELD_ELEV_M) == "ground"


def test_climbing_in_ground_band_is_departing() -> None:
    # Rotating in the band with a strong climb → taking off, not ground.
    aircraft = _aircraft(altitude_geom_m=FIELD_ELEV_M + 20.0, vertical_rate=900.0)
    assert classify(aircraft, FIELD_ELEV_M) == "departing"


def test_descending_is_arriving() -> None:
    aircraft = _aircraft(altitude_geom_m=3000.0, vertical_rate=-1000.0)
    assert classify(aircraft, FIELD_ELEV_M) == "arriving"


def test_climbing_is_departing() -> None:
    aircraft = _aircraft(altitude_geom_m=3000.0, vertical_rate=1800.0)
    assert classify(aircraft, FIELD_ELEV_M) == "departing"


def test_level_low_altitude_is_cruising() -> None:
    # Level flight at low altitude is overflying/transit — neither landing nor
    # taking off, so it must not flip arriving/departing as it passes the field.
    aircraft = _aircraft(altitude_geom_m=3000.0, vertical_rate=0.0)
    assert classify(aircraft, FIELD_ELEV_M) == "cruising"


def test_high_altitude_is_cruising() -> None:
    aircraft = _aircraft(altitude_geom_m=12000.0, vertical_rate=-1000.0)
    assert classify(aircraft, FIELD_ELEV_M) == "cruising"


def test_landing_sequence_until_stopped() -> None:
    # Geometric altitude is used throughout; the field is at 531 m so the ground
    # band is 501-561 m. Each tuple is
    # (phase, alt_geom_m, vertical_rate_fpm, on_ground, expected).
    profile = [
        ("inbound cruise descent", 3000.0, -1200.0, False, "arriving"),
        ("intermediate approach", 1500.0, -1000.0, False, "arriving"),
        ("final approach", 700.0, -800.0, False, "arriving"),
        ("flare into ground band", 545.0, -200.0, False, "ground"),
        ("touchdown reports ground bit", 0.0, 0.0, True, "ground"),
        ("rollout braking", 0.0, 0.0, True, "ground"),
        ("full stop on tarmac", 0.0, 0.0, True, "ground"),
    ]
    for phase, alt, vr, on_ground, expected in profile:
        aircraft = _aircraft(altitude_geom_m=alt, vertical_rate=vr, on_ground=on_ground)
        result = classify(aircraft, FIELD_ELEV_M)
        assert result == expected, f"{phase}: expected {expected}, got {result}"


def test_takeoff_sequence_until_airborne() -> None:
    # The mirror of the landing case: parked (ground bit), rolls, rotates in the
    # band while climbing, then climbs out. (phase, alt_geom_m, vr, on_ground, expected).
    profile = [
        ("holding on runway", 0.0, 0.0, True, "ground"),
        ("takeoff roll", 0.0, 0.0, True, "ground"),
        ("rotation in ground band", 545.0, 600.0, False, "departing"),
        ("initial climb", 800.0, 1800.0, False, "departing"),
        ("climb out", 1500.0, 2000.0, False, "departing"),
        ("en route climb", 3000.0, 1500.0, False, "departing"),
    ]
    for phase, alt, vr, on_ground, expected in profile:
        aircraft = _aircraft(altitude_geom_m=alt, vertical_rate=vr, on_ground=on_ground)
        result = classify(aircraft, FIELD_ELEV_M)
        assert result == expected, f"{phase}: expected {expected}, got {result}"


def test_estimate_field_elevation_from_grounded_traffic() -> None:
    # Two grounded aircraft near the center with geometric altitude → median is
    # used as the field elevation, overriding the seed.
    states = [
        _aircraft(
            altitude_geom_m=470.0, on_ground=True, lat=CENTER_LAT, lon=CENTER_LON
        ),
        _aircraft(
            altitude_geom_m=474.0, on_ground=True, lat=CENTER_LAT, lon=CENTER_LON
        ),
    ]
    est = estimate_field_elevation(states, CENTER_LAT, CENTER_LON, seed_m=531.0)
    assert est == 472.0


def test_estimate_field_elevation_falls_back_to_seed() -> None:
    # No usable grounded traffic (airborne, or grounded with no geom altitude).
    states = [
        _aircraft(altitude_geom_m=3000.0, on_ground=False),
        _aircraft(altitude_geom_m=0.0, on_ground=True),  # geom absent on ground
    ]
    est = estimate_field_elevation(states, CENTER_LAT, CENTER_LON, seed_m=531.0)
    assert est == 531.0
