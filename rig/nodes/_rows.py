"""_rows.py — pure row/record helpers shared by the bridge node (live shadow file) and the converter.

ONE definition on purpose: the converter's fidelity promise (`converted == live`) depends on both
writers encoding a record identically. No ROS imports here — mcap_convert.py must stay runnable
without a ROS process.

  * Kinefly KF/1 → the compact ["kf", …] row (kf_row)
  * a FicTrac line → (tag, fields)                                   (parse_fictrac_line)
  * the FicTrac columns kept in the ArenaFrame record (docs/development/fictrac-columns-in-the-bag.md,
    decided 2026-10-18): cols 5, 6-8, 22 native, 23                  (fictrac_extras)
  * an ArenaFrame record (typed fields or the hub message) → the behavior_v1 row
    [ms, fc, idx, ft, x, y, hd], or None for a flagged (untracked) frame (arena_frame_to_row)
"""

from __future__ import annotations

import math

KF_TAG = "kf"

NAN = float("nan")

# ArenaFrame.flags
FLAG_BAD_FRAME = 1  # bit 0: an FT_BADFR line — FicTrac could not track; no columns, no run-log row

# The FicTrac columns (1-based) kept beyond the behavior row, and the ArenaFrame field each lands in.
FICTRAC_EXTRA_COLS = {"err": 5, "dr_lab_x": 6, "dr_lab_y": 7, "dr_lab_z": 8, "ft_ns": 22, "ft_seq": 23}
BEHAVIOR_ROW_COLS = ("ms", "fc", "idx", "ft", "x", "y", "hd")  # == bridge.py BEHAVIOR_V1_COLS (never widened)


def parse_fictrac_line(raw: str) -> tuple[str, list[float]]:
    """(tag, fields) the way bridge.py's Pipeline parses: a leading FT* token is the tag
    ('' when absent, as in offline .dat lines and the simulator); fields = the floats after
    it, or [] when the line is not numeric (a bad frame has no usable data)."""
    parts = raw.strip().split(",")
    tag = ""
    if parts and parts[0].strip()[:2].upper() == "FT":
        tag = parts[0].strip()
        parts = parts[1:]
    try:
        return tag, [float(p) for p in parts]
    except ValueError:
        return tag, []


def is_bad_frame_tag(tag: str) -> bool:
    """FicTrac's socket output tags every record: "FT" = tracked, anything else starting with
    FT (seen: "FT_BADFR") = a frame it could not track."""
    return tag[:2].upper() == "FT" and tag != "FT"


def fictrac_extras(fields: list[float] | None) -> dict:
    """The kept FicTrac columns beyond the behavior row, as ArenaFrame fields. PURE. A short or
    absent line gives NaN for the floats and 0 for the integers (the typed message cannot carry
    null); `ft_ns` is col 22 truncated to an integer — on our rigs it already is one (ns)."""
    f = fields or []

    def fl(col: int) -> float:
        return float(f[col - 1]) if len(f) >= col else NAN

    def it(col: int) -> int:
        if len(f) < col:
            return 0
        v = f[col - 1]
        return int(v) if math.isfinite(v) else 0

    return {"err": fl(5), "dr_lab_x": fl(6), "dr_lab_y": fl(7), "dr_lab_z": fl(8), "ft_seq": it(23), "ft_ns": it(22)}


def frame_flags(fr: dict) -> int:
    v = fr.get("flags", 0)
    return int(v) if isinstance(v, (int, float)) else 0


def arena_frame_to_row(fr: dict) -> list | None:
    """An /arena/frame record → the behavior_v1 row `[ms, fc, idx, ft, x, y, hd]` the live writer
    emits (bridge.py write_frame), or None when the record is a flagged untracked frame (the
    live writer wrote no row). Accepts the typed ArenaFrame fields (`has_ft`) or the hub message
    the String path records (`ft` None when absent)."""
    if frame_flags(fr) & FLAG_BAD_FRAME:
        return None
    if "has_ft" in fr:  # typed ArenaFrame
        ft = float(fr["ft"]) if fr["has_ft"] else None
        return [int(fr["ms"]), int(fr["fc"]), int(fr["idx"]), ft, float(fr["x"]), float(fr["y"]), float(fr["hd"])]
    return [fr.get(c) for c in BEHAVIOR_ROW_COLS]


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
