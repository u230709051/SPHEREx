"""
End-to-end job: target -> SPHEREx frames (per epoch x detector) + spectrum + light curve.

Parts of this file were written with the assistance of an AI coding assistant
(Claude, Anthropic) and reviewed by the team. See README "Use of AI".
"""
from __future__ import annotations

import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
import time
from collections import OrderedDict

import numpy as np
from astropy.time import Time

import catalogs as cat
import spherex_core as sx

RESULTS_DIR = sx.ROOT / "data" / "results"
_CUTOUT_LRU: "OrderedDict[str, list[sx.Cutout]]" = OrderedDict()
_LRU_LOCK = threading.Lock()
PIPELINE_VERSION = 6


OPTIONAL_KEYS = ("date_start", "date_end")   # left out of the key when not set (keeps old cache keys)


def job_key(p: dict) -> str:
    p = {k: v for k, v in p.items() if not (k in OPTIONAL_KEYS and v is None)}
    sig = json.dumps({k: (round(v, 5) if isinstance(v, float) else v) for k, v in sorted(p.items())}
                     | {"v": PIPELINE_VERSION})
    return hashlib.sha1(sig.encode()).hexdigest()[:16]


def cached_result(key: str) -> dict | None:
    f = RESULTS_DIR / f"{key}.json"
    return json.loads(f.read_text()) if f.exists() else None


def _remember(key: str, cutouts: list[sx.Cutout]):
    with _LRU_LOCK:
        _CUTOUT_LRU[key] = cutouts
        _CUTOUT_LRU.move_to_end(key)
        while len(_CUTOUT_LRU) > 8:          # compact cutouts: ~10-15 MB per field
            _CUTOUT_LRU.popitem(last=False)


_INFLIGHT: dict = {}                       # key -> threading.Event while its cutouts are being loaded
_PREFETCH = ThreadPoolExecutor(max_workers=1)


def cutouts_for(key: str, params: dict, workers: int = 8) -> list[sx.Cutout]:
    """Cutouts of a finished job: from memory, else re-read (disk cache, or the cloud after a restart).
    Images are fetched in parallel, and concurrent callers for the same field wait for one load."""
    with _LRU_LOCK:
        if key in _CUTOUT_LRU:
            return _CUTOUT_LRU[key]
        ev = _INFLIGHT.get(key)
        owner = ev is None
        if owner:
            ev = _INFLIGHT[key] = threading.Event()
    if not owner:
        ev.wait(timeout=600)
        with _LRU_LOCK:
            return _CUTOUT_LRU.get(key, [])
    try:
        res = cached_result(key)
        if not res or res.get("mode") == "moving":
            return []
        ra0, dec0, size = res["grid"]["crval"][0], res["grid"]["crval"][1], res["fov_arcmin"] / 60

        def load(im):
            rec = sx.ImageRecord(uri=im["uri"], mjd=im["mjd"], det=im["det"], epoch=im["epoch"])
            path = sx.fetch_cutout(sx.cutout_url(rec, ra0, dec0, size))
            return sx.load_cutout(rec, path) if path else None

        with ThreadPoolExecutor(max_workers=workers) as pool:
            cutouts = [c for c in pool.map(load, res["images"]) if c is not None]
        if cutouts:
            _remember(key, cutouts)
        return cutouts
    finally:
        with _LRU_LOCK:
            _INFLIGHT.pop(key, None)
        ev.set()


def prefetch_cutouts(key: str):
    """Start loading a field's images in the background (a cached field was just opened), so that
    clicking a star in it answers quickly even right after a server restart."""
    with _LRU_LOCK:
        if key in _CUTOUT_LRU or key in _INFLIGHT:
            return
    def warm():
        # background: only 3 threads, so the server keeps answering requests and Render's health check
        # (on 0.5 CPU, 16 busy threads starved the web thread for >5 s and Render restarted the app)
        cutouts_for(key, {}, workers=3)
        res = cached_result(key)
        if res:
            gaia_neighbors(key, res["grid"]["crval"][0], res["grid"]["crval"][1], res["fov_arcmin"], res["epochs"])
    _PREFETCH.submit(warm)


def target_track(p: dict, mjds: list[float]) -> list[tuple[float, float]]:
    return [cat.propagate(p["ra"], p["dec"], p.get("pmra", 0), p.get("pmdec", 0),
                          p.get("ref_epoch", 2000.0), cat.mjd_to_jyear(m)) for m in mjds]


_GAIA: "OrderedDict[str, dict]" = OrderedDict()


def gaia_neighbors(key: str, ra0: float, dec0: float, fov_arcmin: float, ep_meta: list[dict]) -> dict:
    """Gaia DR3 positions in the field, propagated to every visit: {epoch: [(ra, dec), ...]}.
    Used to deblend the target's PSF photometry from known neighbours."""
    with _LRU_LOCK:
        if key in _GAIA:
            return _GAIA[key]
    out: dict = {}
    try:
        g = cat.gaia_sources(ra0, dec0, fov_arcmin / 60 * 0.75, [e["jyear"] for e in ep_meta], gmax=20.5)
        out = {e["epoch"]: [s["positions"][i] for s in g["sources"]] for i, e in enumerate(ep_meta)}
    except Exception:
        out = {}
    with _LRU_LOCK:
        _GAIA[key] = out
        while len(_GAIA) > 8:
            _GAIA.popitem(last=False)
    return out


def spectrum_and_lightcurve(cutouts, positions_by_epoch=None, ra=None, dec=None,
                            neighbors_by_epoch=None, method: str = "aperture") -> dict:
    """Photometry at a fixed (ra, dec) or at a moving target position per epoch."""
    pts = measure_points(cutouts, positions_by_epoch, ra, dec, neighbors_by_epoch, method)
    return {"points": sorted(pts, key=lambda q: (q["wavelength_um"] or 0)), "lightcurve": light_curve(pts)}


def measure_points(cutouts, positions_by_epoch=None, ra=None, dec=None,
                   neighbors_by_epoch=None, method: str = "aperture") -> list[dict]:
    """One photometry point per cutout (spectral point at that pixel's wavelength)."""
    pts = []
    for c in cutouts:
        if positions_by_epoch is not None:
            r, d = positions_by_epoch[c.rec.epoch]
        else:
            r, d = ra, dec
        nb = None
        if neighbors_by_epoch and neighbors_by_epoch.get(c.rec.epoch):
            arr = np.asarray(neighbors_by_epoch[c.rec.epoch], dtype=float)
            sep = np.hypot((arr[:, 0] - r) * np.cos(np.radians(d)), arr[:, 1] - d) * 3600
            nb = arr[(sep > 6.0) & (sep < 36.0)]
        ph = sx.photometry_at(c, r, d, neighbors=nb, method=method)
        if ph is not None:
            pts.append(ph)
    return pts


def light_curve(pts) -> list[dict]:
    """Robust median flux per (epoch, detector)."""
    lc = []
    cells: dict = {}
    for q in pts:
        if q["good"]:
            cells.setdefault((q["epoch"], q["det"]), []).append(q)
    for (ep, det), qs in sorted(cells.items()):
        f = np.array([q["flux_mjy"] for q in qs])
        lc.append({"epoch": ep, "det": det, "mjd": float(np.mean([q["mjd"] for q in qs])),
                   "flux_mjy": float(np.median(f)),
                   "err_mjy": float(1.253 * np.std(f) / np.sqrt(len(f))) if len(f) > 1 else None,
                   "n": len(qs)})
    return lc


PREVIEW_PER_CELL = 1                         # images per (visit, detector) in the first preview
PUBLISH_EVERY = 4.0                          # seconds between live updates after the preview
KEY_EXCLUDE = ("name", "priority_dets")      # request fields that do not change the final result


def _epoch_meta_from_records(records) -> list[dict]:
    """Visit dates from the image list alone (before anything is downloaded)."""
    out = []
    for ep in sorted({r.epoch for r in records}):
        m = float(np.mean([r.mjd for r in records if r.epoch == ep]))
        out.append({"epoch": ep, "mjd": m, "jyear": cat.mjd_to_jyear(m)})
    return out


def _epoch_meta(cutouts, records) -> list[dict]:
    out = []
    for ep in sorted({c.rec.epoch for c in cutouts}):
        cs = [c for c in cutouts if c.rec.epoch == ep]
        mjds = [c.rec.mjd for c in cs]
        out.append({"epoch": ep, "mjd": float(np.mean(mjds)),
                    "jyear": cat.mjd_to_jyear(float(np.mean(mjds))),
                    "date_start": Time(min(mjds), format="mjd").iso[:10],
                    "date_end": Time(max(mjds), format="mjd").iso[:10],
                    "n_images": len(cs),
                    "n_available": sum(1 for r in records if r.epoch == ep),
                    "dets": sorted({c.rec.det for c in cs})})
    return out


def run_frames_job(p: dict, progress, publish=None) -> dict:
    """p: ra, dec, pmra, pmdec, ref_epoch, fov_arcmin, max_per_cell, budget, name, priority_dets.

    Work is done in three groups so the browser can start blinking early (publish(partial)):
      1. "preview": the detectors on screen (priority_dets), one image of every visit
      2. "sharper": the remaining images of those detectors
      3. final:     the remaining detectors, then the spectrum and light curve
    Each (visit, detector) frame belongs to exactly one group, so frames are built once."""
    t0 = time.time()
    key = job_key({k: v for k, v in p.items() if k not in KEY_EXCLUDE})
    size_deg = p["fov_arcmin"] / 60.0

    # Centre the field on the target's position in the middle of the SPHEREx data range.
    progress("query", 0, 1, "Finding SPHEREx images of this position...")
    ra_mid, dec_mid = cat.propagate(p["ra"], p["dec"], p.get("pmra", 0), p.get("pmdec", 0),
                                    p.get("ref_epoch", 2000.0), 2025.9)
    records = sx.find_images(ra_mid, dec_mid)
    if not records:
        raise RuntimeError("No SPHEREx images cover this position yet.")
    d0, d1 = p.get("date_start"), p.get("date_end")
    if d0 or d1:                                  # user-chosen date range (inclusive, UTC days)
        m0 = Time(d0).mjd if d0 else -1e9
        m1 = Time(d1).mjd + 1 if d1 else 1e9
        inside = [r for r in records if m0 <= r.mjd < m1]
        if not inside:
            visits = sx.group_epochs(list(records))
            dates = ", ".join(Time(min(r.mjd for r in v), format="mjd").iso[:10] for v in visits)
            raise RuntimeError(f"No SPHEREx visits between {d0 or 'the start'} and {d1 or 'today'}. "
                               f"This position was observed on: {dates}.")
        records = inside
    epochs = sx.group_epochs(records)
    n_total = len(records)
    chosen = sx.budget_select(records, p.get("max_per_cell", 8), p.get("budget", 260))
    progress("query", 1, 1, f"{n_total} images in {len(epochs)} visits; downloading {len(chosen)}")
    grid, shape = sx.make_grid(ra_mid, dec_mid, size_deg)

    prio = [d for d in (p.get("priority_dets") or []) if d in sx.DETECTORS] or ["D5", "D6"]
    ep_ids = sorted({r.epoch for r in chosen})
    # first and last visit that the on-screen detectors actually cover (a field near the edge of the
    # focal plane can be seen by only some detectors in a visit)
    ep_prio = sorted({r.epoch for r in chosen if r.det in prio}) or ep_ids
    # Preview: PREVIEW_PER_CELL image(s) of each on-screen detector in EVERY visit, so the whole
    # animation starts at once (noisier); the rest of the images sharpen those frames in stage 2.
    preview = []
    for ep in ep_prio:
        for det in prio:
            cell = [r for r in chosen if r.epoch == ep and r.det == det]
            idx = sorted(set(np.linspace(0, len(cell) - 1, min(PREVIEW_PER_CELL, len(cell))).round().astype(int))) if cell else []
            preview += [cell[i] for i in idx]
    in_preview = {id(r) for r in preview}
    groups = [g for g in (
        ("preview", preview),
        ("sharper", [r for r in chosen if r.det in prio and id(r) not in in_preview]),
        ("final", [r for r in chosen if r.det not in prio])) if g[1]]

    def assemble(cutouts, frames, phot=None, partial=None):
        ep_meta = _epoch_meta(cutouts, records)
        track = target_track(p, [e["mjd"] for e in ep_meta])
        res = {
            "key": key, "name": p.get("name"),
            "target": {k: p.get(k) for k in ("ra", "dec", "pmra", "pmdec", "ref_epoch")},
            "fov_arcmin": p["fov_arcmin"],
            "quality": {"max_per_cell": p.get("max_per_cell", 8), "budget": p.get("budget", 260)},
            "date_range": [p.get("date_start"), p.get("date_end")] if (p.get("date_start") or p.get("date_end")) else None,
            "grid": {"crval": [ra_mid, dec_mid], "crpix": list(grid.wcs.crpix), "cdelt": list(grid.wcs.cdelt),
                     "shape": list(shape)},
            "epochs": [e | {"target_ra": t[0], "target_dec": t[1]} for e, t in zip(ep_meta, track)],
            "frames": [{"epoch": ep, "det": det, "n": n, "data": sx.b64f32(arr)}
                       for (ep, det), (arr, n) in sorted(frames.items())],
            "images": [{"uri": c.rec.uri, "mjd": c.rec.mjd, "det": c.rec.det, "epoch": c.rec.epoch,
                        "obs_id": c.rec.obs_id} for c in cutouts],
            "stats": {"n_total": n_total, "n_downloaded": len(chosen), "n_used": len(cutouts),
                      "rejected": dict(rejected), "seconds": round(time.time() - t0, 1)},
            **(phot or {"points": [], "lightcurve": []}),
        }
        if partial:
            res["partial"] = partial
            res["visits_total"] = len(ep_ids)
        return res, ep_meta, track

    # The preview downloads alone (on a small server the CPU is the bottleneck, so anything running
    # beside it only delays the first frames); the later groups are queued together right after it,
    # in priority order, and download while earlier groups are processed. Every image is reprojected
    # once and measured once; frames and the spectrum are re-published every PUBLISH_EVERY seconds.
    cutouts, frames, rejected = [], {}, {"failed": 0, "transient": 0}
    by_cell: dict = {}
    points: list = []
    pending_phot: list = []
    n_done = [0]
    done_lock = threading.Lock()

    # Target position and Gaia neighbours per visit are known before any image arrives.
    ep_rec = _epoch_meta_from_records(records)
    pos_by_epoch = dict(zip([e["epoch"] for e in ep_rec], target_track(p, [e["mjd"] for e in ep_rec])))
    side = ThreadPoolExecutor(max_workers=1)
    gaia_fut = side.submit(gaia_neighbors, key, ra_mid, dec_mid, p["fov_arcmin"], ep_rec)

    def fetch(rec):
        path = sx.fetch_cutout(sx.cutout_url(rec, ra_mid, dec_mid, size_deg))
        with done_lock:
            n_done[0] += 1
            k = n_done[0]
        progress("download", k, len(chosen), f"Downloading cutouts {k}/{len(chosen)}")
        return path

    def measure(final=False):
        """Photometry of the images waiting for it (needs the Gaia neighbours; never blocks before the end)."""
        if not pending_phot or not (final or gaia_fut.done()):
            return
        nbrs = gaia_fut.result()
        points.extend(measure_points(pending_phot, positions_by_epoch=pos_by_epoch,
                                     neighbors_by_epoch=nbrs, method="psf"))
        pending_phot.clear()

    def snapshot(label):
        phot = {"points": sorted(points, key=lambda q: (q["wavelength_um"] or 0)), "lightcurve": light_curve(points)}
        try:
            publish(assemble(cutouts, frames, phot=phot, partial=label)[0])
        except Exception:
            pass                            # a preview must never break the job

    # 8 parallel downloads saturate a small server's CPU; more would starve the thread below that
    # turns images into frames and spectrum points (Python's GIL), so the charts would lag behind.
    pool = ThreadPoolExecutor(max_workers=8)
    futures = [(groups[0][0], [(rec, pool.submit(fetch, rec)) for rec in groups[0][1]])]
    last_pub = time.time()
    for gi, (label, items) in enumerate(futures):
        touched = set()
        for n_item, (rec, fut) in enumerate(items, 1):
            path = fut.result()
            c = sx.load_cutout(rec, path) if path else None
            if c is None:
                rejected["failed"] += 1
                continue
            if c.n_transient > sx.MAX_TRANSIENT_PIXELS:
                rejected["transient"] += 1
                continue
            cutouts.append(c)
            by_cell.setdefault((c.rec.epoch, c.rec.det), []).append(sx.reproject_one(c, grid, shape))
            touched.add((c.rec.epoch, c.rec.det))
            pending_phot.append(c)
            # in the later groups, publish every few seconds so frames and charts fill in live
            if publish and gi > 0 and time.time() - last_pub > PUBLISH_EVERY and n_item < len(items):
                for cell in touched:
                    frames[cell] = (sx.combine_cell(by_cell[cell]), len(by_cell[cell]))
                touched.clear()
                measure()
                snapshot(label)
                last_pub = time.time()
        for cell in touched:
            frames[cell] = (sx.combine_cell(by_cell[cell]), len(by_cell[cell]))
        if gi > 0:
            measure()
        if publish and frames and gi < len(groups) - 1:   # the final result follows the last group anyway
            snapshot(label)
            last_pub = time.time()
        if gi == 0:                       # preview on screen: queue everything else now
            futures += [(lb, [(rec, pool.submit(fetch, rec)) for rec in grp]) for lb, grp in groups[1:]]
    pool.shutdown(wait=False)
    side.shutdown(wait=False)
    if not cutouts:
        raise RuntimeError("All cutouts failed to download; the archive may be overloaded. Try again shortly.")
    _remember(key, cutouts)

    progress("process", 1, 1, "Measuring the spectrum and light curve (PSF fit, Gaia-deblended)...")
    measure(final=True)
    phot = {"points": sorted(points, key=lambda q: (q["wavelength_um"] or 0)), "lightcurve": light_curve(points)}
    result = assemble(cutouts, frames, phot=phot)[0]
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"{key}.json").write_text(json.dumps(result))
    return result
