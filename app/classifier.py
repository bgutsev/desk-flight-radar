"""Classify aircraft as arriving, departing, cruising, or ground.

The on-ground decision trusts the ADS-B air/ground status bit first
(``on_ground``); failing that, geometric (GPS/WGS84) altitude near the estimated
field elevation. Geometric altitude is used in preference to barometric, which
drifts with local pressure (QNH) and so cannot be compared to a fixed field
elevation reliably — the root cause of misclassified ground traffic. Vertical
motion uses the geometric rate when available, else the barometric rate.

Field elevation is estimated dynamically from the geometric altitude of aircraft
currently reporting the ground bit near the center
(:func:`estimate_field_elevation`), so no per-airport elevation is hardcoded; a
configured value only seeds the estimate until live ground traffic is seen.

  - On the ground (status bit) → ground
  - Geometric altitude within GROUND_TOLERANCE_M of the field, not climbing → ground
  - Above CRUISE_ALTITUDE_M → cruising regardless
  - Descending faster than CLIMB_THRESHOLD_FPM → arriving
  - Climbing faster than CLIMB_THRESHOLD_FPM → departing
  - Level flight at low altitude → cruising (overflying/transit)
"""

from __future__ import annotations

from typing import Literal, Mapping, Sequence

from app.utils import geo

Classification = Literal["arriving", "departing", "cruising", "ground"]

# Above this altitude an aircraft is considered en-route rather than
# serving the local area.
CRUISE_ALTITUDE_M = 8000.0

# Minimum vertical speed (ft/min) to count as a meaningful climb or descent.
CLIMB_THRESHOLD_FPM = 200.0

# Geometric altitude this close to the estimated field elevation counts as on
# the ground. Wider than a barometric band would need, to absorb GPS vertical
# error (typically ±15-25 m).
GROUND_TOLERANCE_M = 30.0

# Aircraft within this distance of the center feed the field-elevation estimate.
FIELD_CALIB_RADIUS_KM = 5.0


def _vertical_rate(aircraft: Mapping[str, object]) -> float:
    """Geometric rate when present, else the barometric rate."""
    geom = aircraft.get("geom_rate_fpm")
    if geom:
        return float(geom)  # type: ignore[arg-type]
    return float(aircraft.get("vertical_rate_fpm", 0.0))  # type: ignore[arg-type]


def estimate_field_elevation(
    aircraft_states: Sequence[Mapping[str, object]],
    center_lat: float,
    center_lon: float,
    seed_m: float,
) -> float:
    """Median geometric altitude of on-ground aircraft near the center.

    Returns ``seed_m`` (the configured field elevation) until at least one
    grounded aircraft with a usable geometric altitude is seen, after which the
    estimate tracks the true field elevation regardless of barometric drift.
    Aircraft without a geometric altitude on the ground (it reads ~0) are
    skipped so they can't drag the estimate to zero.
    """
    elevations: list[float] = []
    for ac in aircraft_states:
        if not ac.get("on_ground"):
            continue
        alt = float(ac.get("altitude_geom_m") or 0.0)  # type: ignore[arg-type]
        if alt <= 0.0:
            continue
        if geo.is_within_radius(
            center_lat,
            center_lon,
            float(ac["latitude"]),  # type: ignore[arg-type]
            float(ac["longitude"]),  # type: ignore[arg-type]
            FIELD_CALIB_RADIUS_KM,
        ):
            elevations.append(alt)
    if not elevations:
        return seed_m
    elevations.sort()
    mid = len(elevations) // 2
    if len(elevations) % 2:
        return elevations[mid]
    return (elevations[mid - 1] + elevations[mid]) / 2.0


def classify(
    aircraft: Mapping[str, object],
    field_elev_m: float,
) -> Classification:
    """Return the arrival/departure/ground state of ``aircraft``."""

    vr = _vertical_rate(aircraft)

    # 1. Authoritative ADS-B air/ground status bit.
    if aircraft.get("on_ground"):
        return "ground"

    # 2. Geometric altitude within the field band and not climbing away → on the
    #    ground (or touching down). A positive climb rate means it is rolling
    #    for takeoff, so that falls through to "departing" below.
    alt_geom = float(aircraft["altitude_geom_m"])  # type: ignore[arg-type]
    if abs(alt_geom - field_elev_m) <= GROUND_TOLERANCE_M and vr <= CLIMB_THRESHOLD_FPM:
        return "ground"

    if alt_geom > CRUISE_ALTITUDE_M:
        return "cruising"

    if vr < -CLIMB_THRESHOLD_FPM:
        return "arriving"
    if vr > CLIMB_THRESHOLD_FPM:
        return "departing"

    # Near-level flight at low altitude: neither descending to land nor climbing
    # to depart, so it is overflying/transiting, not landing or taking off.
    return "cruising"
