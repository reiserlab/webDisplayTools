#!/usr/bin/env python3
"""arena_display.py — render a G6 arena frame the way the Studio and Pattern Designer draw it, as PNG.

Pure (numpy + stdlib), shared by the live `stimulus_node.py` and the offline `foxglove_json.py
--stimulus` converter, so a live dashboard and a replayed bag show the same pixels.

Panel color is a PANEL property (LAB-228): a four-color G6 panel is the standard 20×20 board
with its four LED banks populated with different LEDs in a repeating 2×2 mosaic. This module is
a minimal Python port of `js/panel-color.js`, the one authority, and must stay equal to it:

    bank(row, col) = 2 * ((row + ROW_PARITY_FLIP) % 2) + (col % 2),  ROW_PARITY_FLIP = 1

in HOST coordinates (row 0 = the bottom of the arena, col 0 = left), bench-verified 2026-09-29.
`tests/test_stimulus.py` runs the JS module under Node and compares every cell of every layout,
plus the channel colors, so a change on either side fails the harness.

    render_frame(frame, gs, layout="four-color", duty=255, scale=4) -> (H*scale, W*scale, 3) uint8
    png_bytes(img) -> bytes
"""

from __future__ import annotations

import struct
import zlib

import numpy as np

ROW_PARITY_FLIP = 1  # js/panel-color.js ROW_PARITY_FLIP (bench-verified 2026-09-29)
DEFAULT_LAYOUT = "g6-green"
OFF_RGB = (0x1E, 0x23, 0x29)  # js/panel-color.js OFF_CSS '#1e2329' — an LED that is off

# js/panel-color.js CHANNELS: on-screen primary at full brightness.
CHANNEL_RGB = {
    "green": (153, 255, 51),
    "violet": (150, 60, 255),
    "blue": (40, 120, 255),
    "yellow": (255, 170, 20),
    "red": (255, 50, 40),
    "ir": (190, 70, 110),
}

# js/panel-color.js LAYOUT_DEFS: banks T0..T3.
LAYOUTS = {
    "g6-green": ("green", "green", "green", "green"),
    "four-color": ("violet", "blue", "green", "yellow"),
    "red-ir-v0.4r2": ("red", "ir", "ir", "red"),
    "red-ir-v0.4r1": ("red", "ir", "red", "ir"),
}


def bank_at(row: int, col: int) -> int:
    """Bank index 0..3 of the LED at host (row, col) — js/panel-color.js bankAt."""
    return 2 * ((row + ROW_PARITY_FLIP) & 1) + (col & 1)


def is_mono(layout: str) -> bool:
    banks = LAYOUTS.get(layout)
    return banks is None or len(set(banks)) == 1


def channel_grid(layout: str, rows: int, cols: int) -> np.ndarray:
    """(rows, cols, 3) float64 of each LED's full-brightness color, host row 0 first.

    A mono layout uses the legacy green-phosphor ramp at full (0.6, 1.0, 0.2) × 255, which is what
    js/panel-color.js `legacyRgb` draws (it equals the `green` channel color)."""
    banks = LAYOUTS.get(layout) or LAYOUTS[DEFAULT_LAYOUT]
    if is_mono(layout):
        rgb = np.array((0.6 * 255, 255.0, 0.2 * 255), dtype=np.float64)
        return np.broadcast_to(rgb, (rows, cols, 3)).copy()
    r = np.arange(rows)[:, None]
    c = np.arange(cols)[None, :]
    bank = 2 * ((r + ROW_PARITY_FLIP) & 1) + (c & 1)
    table = np.array([CHANNEL_RGB[b] for b in banks], dtype=np.float64)
    return table[bank]


_GRID_CACHE: dict[tuple[str, int, int], np.ndarray] = {}


def render_frame(frame, gs: int, layout: str = DEFAULT_LAYOUT, duty: int = 255, scale: int = 4) -> np.ndarray:
    """A .pat frame (uint8 (H, W), host row 0 = bottom; values 0..1 for GS2, 0..15 for GS16) → an
    RGB image with the TOP of the arena at the top, each LED `scale`×`scale` pixels.

    Brightness = value / max × duty / 255 (the per-trial duty override scales the whole panel); an
    LED at 0 is drawn in the OFF color, as the Pattern Designer grid does. `frame=None` = the
    arena dark (allOff)."""
    if frame is None:
        raise ValueError("render_frame needs a frame; use render_dark for allOff")
    h, w = frame.shape
    key = (layout, h, w)
    grid = _GRID_CACHE.get(key)
    if grid is None:
        grid = _GRID_CACHE[key] = channel_grid(layout, h, w)
    vmax = 15.0 if gs == 16 else 1.0
    b = np.clip(frame.astype(np.float64) / vmax, 0.0, 1.0) * (max(0, min(255, int(duty))) / 255.0)
    img = grid * b[:, :, None]
    off = frame == 0
    img[off] = OFF_RGB
    img = img[::-1, :, :]  # host row 0 (bottom) → image bottom
    out = np.clip(np.floor(img + 0.5), 0, 255).astype(np.uint8)  # Math.round, as js/panel-color.js pixelCss
    if scale > 1:
        out = np.repeat(np.repeat(out, scale, axis=0), scale, axis=1)
    return out


def render_dark(rows_px: int = 40, cols_px: int = 200, scale: int = 4) -> np.ndarray:
    out = np.empty((rows_px * scale, cols_px * scale, 3), dtype=np.uint8)
    out[:] = OFF_RGB
    return out


def render_placeholder(rows_px: int = 40, cols_px: int = 200, scale: int = 4) -> np.ndarray:
    """A pattern the node cannot find: a gray hatch, so it never looks like 'dark' or 'lit'."""
    out = render_dark(rows_px, cols_px, scale)
    yy, xx = np.mgrid[0:rows_px * scale, 0:cols_px * scale]
    out[((xx + yy) // (4 * scale)) % 2 == 0] = (70, 74, 80)
    return out


def png_bytes(img: np.ndarray) -> bytes:
    """8-bit grayscale (H, W) or RGB (H, W, 3) → PNG (stdlib zlib; no Pillow in the env)."""
    color_type = 0 if img.ndim == 2 else 2
    h, w = img.shape[:2]
    rows = np.ascontiguousarray(img, dtype=np.uint8).reshape(h, -1)
    raw = np.concatenate([np.zeros((h, 1), dtype=np.uint8), rows], axis=1).tobytes()

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))
