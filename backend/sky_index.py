"""
Our own SPHEREx footprint index: which Level-2 images cover a sky position, answered locally in
milliseconds, without asking the IRSA database.

Every exposure is stored as the unit vector (x, y, z) of its reference detector's centre plus that
detector's TAN pointing. A search is
  1. one dot product per exposure: keep those whose centre is within ~6.6 deg (cos > threshold),
  2. a vectorised gnomonic projection of the target into each candidate's pixel frame,
  3. fixed focal-plane maps (scripts/build_index.py "calibrate") to the three detector pairs
     D1/D4, D2/D5, D3/D6, keeping images whose 2040 x 2040 pixel area contains the target.
Built by scripts/build_index.py from the public AWS copy (s3://nasa-irsa-spherex).

Parts of this file were written with the assistance of an AI coding assistant
(Claude, Anthropic) and reviewed by the team. See README "Use of AI".
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np

IDX_DIR = Path(__file__).resolve().parents[1] / "data" / "index"
NPIX = 2040
MARGIN_PX = 20                      # focal-plane model vs full SIP WCS: 20 px misses none of 1935 IRSA-verified images
SEARCH_RADIUS_DEG = 6.6             # neighbour array centre (3.9 deg) + half diagonal (2.5 deg) + slack
GROUP_DETS = {0: (1, 4), 1: (2, 5), 2: (3, 6)}
_lock = threading.Lock()
_idx = None


def available() -> bool:
    return (IDX_DIR / "spherex_index.npz").exists() and (IDX_DIR / "focal_plane.json").exists()


def _load():
    global _idx
    with _lock:
        if _idx is None:
            z = np.load(IDX_DIR / "spherex_index.npz")
            maps = json.loads((IDX_DIR / "focal_plane.json").read_text())
            _idx = {k: z[k] for k in z.files}
            for k in ("rel", "obs", "week"):          # ASCII names: 1 byte per character instead of 4 (-25 MB)
                _idx[k] = _idx[k].astype("S")
            _idx["maps"] = {int(r): {int(g): np.array(m) for g, m in d.items()} for r, d in maps.items()}
    return _idx


def info() -> dict:
    if not available():
        return {"available": False}
    z = _load()
    return {"available": True, "exposures": int(len(z["mjd"])), "images": int((z["detver"] >= 0).sum()),
            "built": str(z["built"]), "mjd_max": float(z["mjd"].max())}


def _tan_pix(w, ra, dec):
    """w: (n, 10) = CRPIX1, CRPIX2, CRVAL1, CRVAL2, CDELT1, CDELT2, PC1_1, PC1_2, PC2_1, PC2_2."""
    ra0, dec0 = np.radians(w[:, 2]), np.radians(w[:, 3])
    ra, dec = np.radians(ra), np.radians(dec)
    cosc = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
    xi = np.degrees(np.cos(dec) * np.sin(ra - ra0) / cosc)
    eta = np.degrees((np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / cosc)
    a, b = w[:, 6] * w[:, 4], w[:, 7] * w[:, 4]
    c, d = w[:, 8] * w[:, 5], w[:, 9] * w[:, 5]
    det = a * d - b * c
    return (d * xi - b * eta) / det + w[:, 0] - 1, (-c * xi + a * eta) / det + w[:, 1] - 1


def find(ra: float, dec: float) -> list[tuple[str, float, str]]:
    """(S3 key, MJD, detector name) of every image whose footprint contains (ra, dec)."""
    z = _load()
    r, d = np.radians(ra), np.radians(dec)
    v = np.array([np.cos(d) * np.cos(r), np.cos(d) * np.sin(r), np.sin(d)], np.float32)
    cand = np.nonzero(z["xyz"] @ v > np.cos(np.radians(SEARCH_RADIUS_DEG)))[0]
    if not len(cand):
        return []
    w = z["wcs"][cand]
    px, py = _tan_pix(w, ra, dec)
    out = []
    for ref in np.unique(z["ref"][cand]):
        sel = np.nonzero(z["ref"][cand] == ref)[0]
        P = np.c_[px[sel], py[sel], np.ones(len(sel))]
        for g, M in z["maps"][int(ref)].items():
            q = P @ M
            inside = ((q[:, 0] > -MARGIN_PX) & (q[:, 0] < NPIX - 1 + MARGIN_PX)
                      & (q[:, 1] > -MARGIN_PX) & (q[:, 1] < NPIX - 1 + MARGIN_PX))
            for i in cand[sel[inside]]:
                for det in GROUP_DETS[g]:
                    vi = z["detver"][i, det - 1]
                    if vi < 0:
                        continue
                    ver, obs = str(z["versions"][vi]), z["obs"][i].decode()
                    key = (f"{z['rel'][i].decode()}/level2/{z['week'][i].decode()}/{ver}/{det}/"
                           f"level2_{obs}D{det}_spx_{ver}.fits")
                    out.append((key, float(z["mjd"][i]), f"D{det}"))
    return sorted(out, key=lambda t: t[1])
