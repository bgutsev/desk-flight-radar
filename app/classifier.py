"""Classify aircraft as arriving, departing, or cruising.

Primary signal: vertical rate (baro_rate from ADS-B).
  - Descending at more than CLIMB_THRESHOLD_FPM  → arriving
  - Climbing  at more than CLIMB_THRESHOLD_FPM  → departing
  - High-altitude traffic (above CRUISE_ALTITUDE_M) → cruising regardless
  - Level flight at low altitude → heading-toward-center fallback
"""

from __future__ import annotations

from typing import Literal, Mapping

from app.utils import geo

Classification = Literal["arriving", "departing", "cruising"]

# Above this altitude an aircraft is considered en-route rather than
# serving the local area.
CRUISE_ALTITUDE_M = 8000.0

# Minimum vertical speed (ft/min) to count as a meaningful climb or descent.
CLIMB_THRESHOLD_FPM = 200.0

# Fallback: heading within this half-angle of bearing-to-center → arriving.
APPROACH_HALF_ANGLE_DEG = 90.0


def classify(
    aircraft: Mapping[str, object],
    center_lat: float,
    center_lon: float,
) -> Classification:
    """Return the arrival/departure state of ``aircraft`` w.r.t. the center."""

    altitude_m = float(aircraft["altitude_m"])  # type: ignore[arg-type]
    if altitude_m > CRUISE_ALTITUDE_M:
        return "cruising"

    vr = float(aircraft.get("vertical_rate_fpm", 0.0))  # type: ignore[arg-type]
    if vr < -CLIMB_THRESHOLD_FPM:
        return "arriving"
    if vr > CLIMB_THRESHOLD_FPM:
        return "departing"

    # Near-level flight at low altitude: fall back to heading geometry.
    ac_lat = float(aircraft["latitude"])  # type: ignore[arg-type]
    ac_lon = float(aircraft["longitude"])  # type: ignore[arg-type]
    heading = float(aircraft["heading_deg"])  # type: ignore[arg-type]
    target_bearing = geo.bearing_deg(ac_lat, ac_lon, center_lat, center_lon)
    rel = abs(geo.relative_bearing(heading, target_bearing))
    return "arriving" if rel < APPROACH_HALF_ANGLE_DEG else "departing"
