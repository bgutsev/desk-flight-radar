"""Classify aircraft as arriving, departing, or cruising.

The signal is purely geometric: compare the aircraft's heading against the
bearing from the aircraft toward the query center. If the nose points roughly at
the center the aircraft is approaching (arriving); if it points away it is
receding (departing). High-altitude traffic is treated as cruising regardless of
heading, since it is overflying rather than serving the center.
"""

from __future__ import annotations

from typing import Literal, Mapping

from app.utils import geo

Classification = Literal["arriving", "departing", "cruising"]

# Above this altitude an aircraft is considered en-route rather than
# arriving/departing the area of interest.
CRUISE_ALTITUDE_M = 11000.0

# A relative bearing whose magnitude is below this points "toward" the center.
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

    ac_lat = float(aircraft["latitude"])  # type: ignore[arg-type]
    ac_lon = float(aircraft["longitude"])  # type: ignore[arg-type]
    heading = float(aircraft["heading_deg"])  # type: ignore[arg-type]

    target_bearing = geo.bearing_deg(ac_lat, ac_lon, center_lat, center_lon)
    rel = abs(geo.relative_bearing(heading, target_bearing))

    return "arriving" if rel < APPROACH_HALF_ANGLE_DEG else "departing"
