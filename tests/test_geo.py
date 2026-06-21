import math

from app.utils import geo


def test_haversine_known_distance() -> None:
    # Sofia (42.6977, 23.3219) -> Plovdiv (42.1354, 24.7453) ~= 130 km.
    distance = geo.haversine_km(42.6977, 23.3219, 42.1354, 24.7453)
    assert math.isclose(distance, 130.0, abs_tol=8.0)


def test_haversine_zero_for_same_point() -> None:
    assert geo.haversine_km(42.0, 23.0, 42.0, 23.0) == 0.0


def test_is_within_radius_boundaries() -> None:
    # ~9 km north of center.
    assert geo.is_within_radius(42.6977, 23.3219, 42.78, 23.3219, 50) is True
    # Far away.
    assert geo.is_within_radius(42.6977, 23.3219, 48.0, 23.3219, 50) is False


def test_bearing_cardinal_directions() -> None:
    # Due north.
    assert math.isclose(geo.bearing_deg(0.0, 0.0, 1.0, 0.0), 0.0, abs_tol=0.5)
    # Due east.
    assert math.isclose(geo.bearing_deg(0.0, 0.0, 0.0, 1.0), 90.0, abs_tol=0.5)
    # Due south.
    assert math.isclose(geo.bearing_deg(1.0, 0.0, 0.0, 0.0), 180.0, abs_tol=0.5)
    # Due west.
    assert math.isclose(geo.bearing_deg(0.0, 1.0, 0.0, 0.0), 270.0, abs_tol=0.5)


def test_relative_bearing_aligned() -> None:
    assert geo.relative_bearing(90.0, 90.0) == 0.0


def test_relative_bearing_sign_and_wraparound() -> None:
    # Target 30 deg to the right of heading.
    assert math.isclose(geo.relative_bearing(0.0, 30.0), 30.0)
    # Target to the left.
    assert math.isclose(geo.relative_bearing(30.0, 0.0), -30.0)
    # Wraparound across 0/360.
    assert math.isclose(geo.relative_bearing(350.0, 10.0), 20.0)
    # Directly behind normalises to +180.
    assert geo.relative_bearing(0.0, 180.0) == 180.0
