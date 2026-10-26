#!/usr/bin/env python3
"""patfile.py — a minimal reader for G6 `.pat` pattern files (G6PT V1/V2), mirroring js/pat-parser.js.

    from patfile import read_pat
    pat = read_pat("G6_2x10_toprow_grat20_violet_gs16.pat")
    pat["frames"][0]          # uint8 array (rows*20, cols*20); pixel ROW 0 = the BOTTOM of the arena
    pat["gs"]                 # 2 (GS2: 0/1) or 16 (GS16: 0..15)

Layout (the JS parser is the reference):
  header V1 (17 B): "G6PT", version(1), gs_val, num_frames u16 LE, row_count, col_count, checksum, panel_mask(6)
  header V2 (18 B): "G6PT", [VVVV][AAAA], [AA][OOOOOO], num_frames u16 LE, row_count, col_count, gs_val,
                    panel_mask(6), CRC-8/AUTOSAR over bytes 0-16
  frame: "FR" + index u16 LE (4 B), then row_count*col_count panel blocks (53 B GS2 / 203 B GS16:
         header(1) cmd(1) data(50|200) stretch(1)), then (V2 only) a CRC-16/CCITT-FALSE trailer (2 B).
  panel pixels: row-major within the panel; GS16 even pixel = high nibble; the ENCODER flipped rows,
         so output row = 19 - encoded row. Panel row 0 = bottom of the arena.
No CRC checking here (the Studio does that); this is a presentation reader.
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

PANEL = 20


def read_pat(path):
    b = Path(path).read_bytes()
    if b[:4] != b"G6PT":
        raise ValueError(f"{path}: not a G6PT pattern (magic {b[:4]!r})")
    version = b[4] if b[4] in (1, 2) else (b[4] >> 4)
    if version == 1:
        gs_raw, header_size, trailer = b[5], 17, 0
    elif version == 2:
        gs_raw, header_size, trailer = b[10], 18, 2
    else:
        raise ValueError(f"{path}: unknown G6PT header version {version}")
    num_frames = struct.unpack_from("<H", b, 6)[0]
    rows, cols = b[8], b[9]
    gs = 16 if gs_raw == 2 else 2
    panel_bytes = 203 if gs == 16 else 53
    frames = []
    off = header_size
    for _ in range(num_frames):
        if b[off:off + 2] != b"FR":
            raise ValueError(f"{path}: frame header 'FR' missing at offset {off}")
        off += 4
        frame = np.zeros((rows * PANEL, cols * PANEL), dtype=np.uint8)
        for pr in range(rows):
            for pc in range(cols):
                blk = b[off:off + panel_bytes]
                off += panel_bytes
                data = np.frombuffer(blk[2:2 + (200 if gs == 16 else 50)], dtype=np.uint8)
                if gs == 16:
                    px = np.empty(PANEL * PANEL, dtype=np.uint8)
                    px[0::2] = data >> 4
                    px[1::2] = data & 0x0F
                else:
                    px = np.unpackbits(data)[: PANEL * PANEL]
                panel = px.reshape(PANEL, PANEL)[::-1, :]  # undo the encoder's row flip
                frame[pr * PANEL:(pr + 1) * PANEL, pc * PANEL:(pc + 1) * PANEL] = panel
        off += trailer
        frames.append(frame)
    return {"version": version, "gs": gs, "rows": rows, "cols": cols, "num_frames": num_frames, "frames": frames,
            "panel_mask": b[11:17].hex()}


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        pat = read_pat(p)
        f0 = pat["frames"][0]
        print(f"{Path(p).name}: V{pat['version']} GS{pat['gs']} {pat['rows']}x{pat['cols']} panels, {pat['num_frames']} frames, "
              f"frame0 lit {(f0 > 0).mean():.2%}, top row lit {(f0[PANEL:] > 0).mean():.2%}, bottom row lit {(f0[:PANEL] > 0).mean():.2%}")
