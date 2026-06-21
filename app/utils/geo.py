"""Pure geographic helpers — no third-party dependencies.

All functions operate on decimal degrees and are side-effect free, which keeps
them trivial to unit test in isolation.
"""

from __future__ import annotations

import math

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""

    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def is_within_radius(
    center_lat: float,
    center_lon: float,
    lat: float,
    lon: float,
    radius_km: float,
) -> bool:
    """True if ``(lat, lon)`` lies within ``radius_km`` of the center point."""

    return haversine_km(center_lat, center_lon, lat, lon) <= radius_km


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial compass bearing (0–360) from point 1 toward point 2."""

    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_lambda = math.radians(lon2 - lon1)

    x = math.sin(d_lambda) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(
        d_lambda
    )
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def relative_bearing(heading_deg: float, target_bearing_deg: float) -> float:
    """Signed angle (-180, 180] between a heading and a target bearing.

    ``0`` means the heading points straight at the target; the sign indicates
    which side the target sits on (negative = left, positive = right).
    """

    diff = (target_bearing_deg - heading_deg + 180.0) % 360.0 - 180.0
    # Normalise -180 to +180 so the range is half-open and predictable.
    return 180.0 if diff == -180.0 else diff
