#!/usr/bin/env python3
"""ufmf.py — a reader for the uFMF movies BIAS writes (version 4), numpy only.

    from ufmf import UfmfReader
    with UfmfReader("run_cam_0_date_…_v001.ufmf") as u:
        u.n_frames, u.width, u.height
        ts, img = u.frame(i)          # ts = BIAS's frame timestamp (s); img uint8 (H, W)
        u.timestamps                  # every frame's timestamp, from the index

The layout is BIAS's writer (bias/src/gui/video_writer_ufmf.cpp), little-endian:
  header    "ufmf" · version u32 · index_loc u64 · max_w u16 · max_h u16 · is_fixed_size u8 ·
            coding_len u8 · coding ("MONO8")
  chunk 0   keyframe: type_len u8 · type ("mean") · dtype char ('B') · w u16 · h u16 · ts f64 · w·h bytes
  chunk 1   frame: ts f64 · n_boxes u32 · n × (col u16 · row u16 · w u16 · h u16 · w·h bytes)
  chunk 2   index (BIAS's index_loc points just past the chunk id byte): a dict — 'd' · n_keys u8 · n × (key_len u16 · key · value),
            value = 'd' (a dict) | 'a' · dtype char ('q' u64, 'd' f64) · n_bytes u32 · data;
            {"frame": {"loc", "timestamp"}, "keyframe": {"mean": {"loc", "timestamp"}}}
A frame is the latest "mean" keyframe at or before it, with the frame's boxes pasted on top.
A file whose index was never written (BIAS killed mid-recording) is scanned chunk by chunk.
"""

from __future__ import annotations

import struct
from bisect import bisect_right
from pathlib import Path

import numpy as np

KEYFRAME, FRAME, INDEX = 0, 1, 2
DTYPES = {"q": ("<u8", 8), "Q": ("<u8", 8), "d": ("<f8", 8), "f": ("<f4", 4), "B": ("u1", 1), "I": ("<u4", 4), "H": ("<u2", 2)}


class UfmfError(ValueError):
    pass


class UfmfReader:
    def __init__(self, path) -> None:
        self.path = Path(path)
        self.f = open(self.path, "rb")
        self._read_header()
        self._bg_cache: dict[int, np.ndarray] = {}
        self.indexed = False
        try:
            self._read_index()
            self.indexed = True
        except (UfmfError, struct.error, OSError):
            self._scan()

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        self.f.close()

    # ── header + index ─────────────────────────────────────────────────────────
    def _read(self, n: int) -> bytes:
        b = self.f.read(n)
        if len(b) != n:
            raise UfmfError(f"{self.path.name}: truncated at offset {self.f.tell()}")
        return b

    def _read_header(self) -> None:
        magic = self._read(4)
        if magic != b"ufmf":
            raise UfmfError(f"{self.path.name}: not a uFMF file (magic {magic!r})")
        self.version, self.index_loc = struct.unpack("<IQ", self._read(12))
        self.max_w, self.max_h = struct.unpack("<HH", self._read(4))
        self.fixed_size = bool(self._read(1)[0]) if self.version >= 4 else False
        n = self._read(1)[0]
        self.coding = self._read(n).decode("ascii", errors="replace")
        self.data_start = self.f.tell()
        if self.coding.upper() not in ("MONO8", "RAW8"):
            raise UfmfError(f"{self.path.name}: only 8-bit mono uFMF is supported (coding {self.coding!r})")

    def _read_value(self):
        kind = self._read(1)
        if kind == b"d":
            return self._read_dict_body()
        if kind == b"a":
            dt = self._read(1).decode()
            (nbytes,) = struct.unpack("<I", self._read(4))
            if dt not in DTYPES:
                raise UfmfError(f"unknown index dtype {dt!r}")
            return np.frombuffer(self._read(nbytes), dtype=DTYPES[dt][0])
        raise UfmfError(f"unknown index value kind {kind!r}")

    def _read_dict_body(self) -> dict:
        n = self._read(1)[0]
        out = {}
        for _ in range(n):
            (klen,) = struct.unpack("<H", self._read(2))
            key = self._read(klen).decode("ascii", errors="replace")
            out[key] = self._read_value()
        return out

    def _read_index(self) -> None:
        if not self.index_loc:
            raise UfmfError("no index")
        self.f.seek(self.index_loc)
        b = self._read(1)
        if b[0] == INDEX:  # motmot's writers point at the chunk id; BIAS points just past it
            b = self._read(1)
        if b != b"d":
            raise UfmfError("index is not a dict")
        idx = self._read_dict_body()
        fr = idx.get("frame") or {}
        kf = (idx.get("keyframe") or {}).get("mean") or {}
        self.frame_locs = np.asarray(fr.get("loc", []), dtype=np.uint64)
        self.timestamps = np.asarray(fr.get("timestamp", []), dtype=np.float64)
        self.kf_locs = np.asarray(kf.get("loc", []), dtype=np.uint64)
        self.kf_ts = np.asarray(kf.get("timestamp", []), dtype=np.float64)
        if len(self.frame_locs) != len(self.timestamps) or not len(self.kf_locs):
            raise UfmfError("index incomplete")

    def _scan(self) -> None:
        """No usable index: walk the chunks from the header to the end (or the first torn chunk)."""
        locs, ts, kf_locs, kf_ts = [], [], [], []
        size = self.path.stat().st_size

        def skip(n: int) -> None:  # seek() past the end does not raise: a torn chunk would count
            if self.f.tell() + n > size:
                raise UfmfError("torn chunk")
            self.f.seek(n, 1)

        self.f.seek(self.data_start)
        while True:
            pos = self.f.tell()
            head = self.f.read(1)
            if not head:
                break
            try:
                cid = head[0]
                if cid == KEYFRAME:
                    t_len = self._read(1)[0]
                    self._read(t_len + 1)
                    w, h = struct.unpack("<HH", self._read(4))
                    (t,) = struct.unpack("<d", self._read(8))
                    skip(w * h)
                    kf_locs.append(pos)
                    kf_ts.append(t)
                elif cid == FRAME:
                    (t,) = struct.unpack("<d", self._read(8))
                    (n,) = struct.unpack("<I", self._read(4))
                    for _ in range(n):
                        _, _, w, h = struct.unpack("<HHHH", self._read(8))
                        skip(w * h)
                    locs.append(pos)
                    ts.append(t)
                else:
                    break  # the index chunk, or garbage after a crash
            except (UfmfError, struct.error):
                break
        self.frame_locs = np.asarray(locs, dtype=np.uint64)
        self.timestamps = np.asarray(ts, dtype=np.float64)
        self.kf_locs = np.asarray(kf_locs, dtype=np.uint64)
        self.kf_ts = np.asarray(kf_ts, dtype=np.float64)
        if not len(self.kf_locs):
            raise UfmfError(f"{self.path.name}: no background keyframe found")

    # ── frames ─────────────────────────────────────────────────────────────────
    @property
    def n_frames(self) -> int:
        return len(self.frame_locs)

    def _keyframe(self, k: int) -> np.ndarray:
        if k in self._bg_cache:
            return self._bg_cache[k]
        self.f.seek(int(self.kf_locs[k]))
        if self._read(1)[0] != KEYFRAME:
            raise UfmfError("keyframe chunk id mismatch")
        t_len = self._read(1)[0]
        self._read(t_len)
        dt = self._read(1).decode()
        if dt != "B":
            raise UfmfError(f"keyframe dtype {dt!r} not supported")
        w, h = struct.unpack("<HH", self._read(4))
        self._read(8)
        img = np.frombuffer(self._read(w * h), dtype=np.uint8).reshape(h, w)
        if len(self._bg_cache) > 4:
            self._bg_cache.clear()
        self._bg_cache[k] = img
        return img

    @property
    def width(self) -> int:
        return self._keyframe(0).shape[1]

    @property
    def height(self) -> int:
        return self._keyframe(0).shape[0]

    def frame(self, i: int) -> tuple[float, np.ndarray]:
        """(timestamp s, uint8 (H, W)) of frame i: its background with its boxes pasted on."""
        t = float(self.timestamps[i])
        k = max(0, bisect_right(self.kf_ts.tolist(), t) - 1) if len(self.kf_ts) > 1 else 0
        img = self._keyframe(k).copy()
        self.f.seek(int(self.frame_locs[i]))
        if self._read(1)[0] != FRAME:
            raise UfmfError(f"frame {i}: chunk id mismatch")
        self._read(8)
        (n,) = struct.unpack("<I", self._read(4))
        H, W = img.shape
        for _ in range(n):
            x, y, w, h = struct.unpack("<HHHH", self._read(8))
            box = np.frombuffer(self._read(w * h), dtype=np.uint8).reshape(h, w)
            x1, y1 = min(W, x + w), min(H, y + h)
            if x < W and y < H:
                img[y:y1, x:x1] = box[: y1 - y, : x1 - x]
        return t, img


def downsample(img: np.ndarray, factor: int) -> np.ndarray:
    """Mean over factor × factor blocks (edges cropped)."""
    if factor <= 1:
        return img
    h, w = (img.shape[0] // factor) * factor, (img.shape[1] // factor) * factor
    return img[:h, :w].reshape(h // factor, factor, w // factor, factor).mean(axis=(1, 3)).astype(np.uint8)


if __name__ == "__main__":
    import sys

    for p in sys.argv[1:]:
        with UfmfReader(p) as u:
            ts = u.timestamps
            fps = (len(ts) - 1) / (ts[-1] - ts[0]) if len(ts) > 1 and ts[-1] > ts[0] else 0.0
            print(f"{Path(p).name}: v{u.version} {u.coding} {u.width}×{u.height}, {u.n_frames} frames, "
                  f"{len(u.kf_locs)} keyframes, {ts[0] if len(ts) else 0:.3f}–{ts[-1] if len(ts) else 0:.3f} s ({fps:.1f} fps), "
                  f"index {'read' if u.indexed else 'MISSING (scanned)'}")
