"""_rows.py — pure row encoders shared by the bridge node (live shadow file) and the converter.

ONE definition on purpose: the converter's fidelity promise (`converted == live`) depends on both
writers encoding a Kinefly record identically. No ROS imports here — mcap_convert.py must stay
runnable without a ROS process.
"""

from __future__ import annotations

KF_TAG = "kf"

def kf_row(rel_ms: int, pkt: dict, seq: int) -> list:
    """KF/1 record → compact tagged row. PURE. Angles are the FIRST (strongest-edge)
    angle of each part when the part is valid, else null — Kinefly's bridge plan: the
    edge identity policy is explicit, index 0 is only the initial single-edge choice."""

    def first_angle(name: str):
        part = pkt.get("parts", {}).get(name) or {}
        if not part.get("valid"):
            return None
        angles = part.get("angles_rad") or []
        return round(float(angles[0]), 5) if angles else None

    t_src = pkt.get("timestamp_s")
    return [
        KF_TAG,
        int(rel_ms),
        int(seq),
        round(float(t_src), 6) if isinstance(t_src, (int, float)) else None,
        first_angle("left"),
        first_angle("right"),
        first_angle("head"),
        first_angle("abdomen"),
    ]
