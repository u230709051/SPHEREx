"""
Single images of one visit on the viewer grid, for the browser's parallax tracker.

The normal frames are a per-pixel median of all images of a visit. That removes cosmic rays, but
also anything that moves during the visit (10-40 days). A distant body drifts across the sky mostly
because the Earth moves: ~17 px during a 15-day visit at 100 AU, ~3 px at 500 AU (SPHEREx looks
~90 deg from the Sun, where this drift is smallest). The tracker shifts the single images
along the path of a body at a trial distance (plus a small constant rate for its own orbital
motion) and takes the median again, so such a body adds up instead of vanishing.

For each image this returns the reprojected pixels and the Earth's barycentric position at that
moment (ICRS, AU, astropy's built-in ephemeris, no network). SPHEREx orbits ~700 km above the
Earth, which is negligible for bodies beyond ~30 AU.

Parts of this file were written with the assistance of an AI coding assistant
(Claude, Anthropic) and reviewed by the team. See README "Use of AI".
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

from astropy.coordinates import get_body_barycentric
from astropy.time import Time

import pipeline as pl
import spherex_core as sx


def visit_images(key: str, epoch: int) -> dict | None:
    """{"epoch", "images": [{"mjd", "det", "earth": [x, y, z], "data": base64 float32}]} or None."""
    cache = pl.RESULTS_DIR / f"trk_{key}_{epoch}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    res = pl.cached_result(key)
    if not res or res.get("mode") == "moving":
        return None
    ra0, dec0 = res["grid"]["crval"]
    size = res["fov_arcmin"] / 60.0
    with pl._LRU_LOCK:
        cached = pl._CUTOUT_LRU.get(key)
    if cached is not None:
        cutouts = [c for c in cached if c.rec.epoch == epoch]
    else:   # only this visit's cutouts, in parallel (the whole field is not needed)
        recs = [sx.ImageRecord(uri=im["uri"], mjd=im["mjd"], det=im["det"], epoch=im["epoch"])
                for im in res["images"] if im["epoch"] == epoch]
        with ThreadPoolExecutor(max_workers=6) as pool:   # 6, not 16: leave CPU for other visitors
            paths = list(pool.map(lambda r: sx.fetch_cutout(sx.cutout_url(r, ra0, dec0, size)), recs))
        cutouts = [c for c in (sx.load_cutout(r, p) for r, p in zip(recs, paths) if p) if c is not None]
    cutouts.sort(key=lambda c: c.rec.mjd)
    if not cutouts:
        return None
    grid, shape = sx.make_grid(ra0, dec0, size)
    earth = get_body_barycentric("earth", Time([c.rec.mjd for c in cutouts], format="mjd")).xyz.to_value("AU").T
    out = {"epoch": epoch, "images": [
        {"mjd": c.rec.mjd, "det": c.rec.det, "earth": [round(float(v), 9) for v in e],
         "data": sx.b64f32(sx.reproject_one(c, grid, shape)[0])}
        for c, e in zip(cutouts, earth)]}
    cache.write_text(json.dumps(out))
    return out
