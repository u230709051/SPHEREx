"""
FastAPI server for the SPHEREx time-machine web tool.

Run:  .venv/bin/uvicorn main:app --app-dir backend --port 8000

Parts of this file were written with the assistance of an AI coding assistant
(Claude, Anthropic) and reviewed by the team. See README "Use of AI".
"""
from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import catalogs as cat
import moving as mv
import pipeline as pl
import spherex_core as sx

app = FastAPI(title="SPHEREx Time Machine API")
app.add_middleware(GZipMiddleware, minimum_size=2000)


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Make browsers revalidate the page, script and styles so new deploys show up immediately."""
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp
FRONTEND = sx.ROOT / "frontend"

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
MAX_JOBS_KEPT = 40
# One field at a time: the Render instance has 512 MB, and two jobs with full-size images in memory
# at once pushed it over the limit (Render restarted the app, 502). A second request waits its turn.
EXECUTOR = ThreadPoolExecutor(max_workers=1)


def _limit_malloc():
    """glibc gives every thread its own memory arena (up to 8 x CPUs); with our download threads that
    adds 100+ MB of unused heap. Two arenas are plenty. Linux only; elsewhere this does nothing."""
    try:
        import ctypes
        libc = ctypes.CDLL("libc.so.6")
        libc.mallopt(-8, 2)            # M_ARENA_MAX = 2
        return libc
    except (OSError, AttributeError):
        return None


_LIBC = _limit_malloc()


def _release_memory():
    """Give freed memory back to the system after a job (glibc keeps it otherwise)."""
    if _LIBC is not None:
        try:
            _LIBC.malloc_trim(0)
        except AttributeError:
            pass


class FramesRequest(BaseModel):
    ra: float
    dec: float
    pmra: float = 0.0
    pmdec: float = 0.0
    ref_epoch: float = 2000.0
    fov_arcmin: float = Field(5.0, ge=1.0, le=20.0)
    max_per_cell: int = Field(8, ge=2, le=40)
    budget: int = Field(260, ge=20, le=1200)
    name: str | None = None
    priority_dets: list[str] | None = Field(None, max_length=6)   # detectors on screen: processed first
    date_start: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")   # optional range of visits (UTC)
    date_end: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class MovingRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    start: str | None = None          # YYYY-MM-DD
    end: str | None = None
    fov_arcmin: float = Field(4.0, ge=1.0, le=15.0)
    max_frames: int = Field(40, ge=4, le=120)


def _set(job_id, **kw):
    with JOBS_LOCK:
        JOBS[job_id].update(kw)


def _run(job_id: str, params: dict, fn=None):
    def progress(stage, i, n, msg):
        _set(job_id, stage=stage, done=i, total=n, message=msg)

    def publish(partial):
        with JOBS_LOCK:
            JOBS[job_id]["partial"] = partial
            JOBS[job_id]["partial_n"] = JOBS[job_id].get("partial_n", 0) + 1
    try:
        res = fn(params, progress) if fn else pl.run_frames_job(params, progress, publish)
        _set(job_id, status="done", result_key=res["key"], message="Done")
    except mv.AmbiguousName as err:
        _set(job_id, status="error", message=str(err), candidates=err.candidates)
    except Exception as err:
        traceback.print_exc()
        _set(job_id, status="error", message=str(err))
    finally:
        with JOBS_LOCK:
            JOBS[job_id].pop("partial", None)      # the finished result is on disk; drop the copy in memory
            JOBS[job_id].pop("params", None)
            done = [k for k, j in JOBS.items() if j.get("status") != "running"]
            for k in done[:-MAX_JOBS_KEPT]:         # forget old finished jobs (dicts keep insertion order)
                JOBS.pop(k, None)
        _release_memory()


@app.on_event("startup")
def warm_demo_fields():
    """After a (re)start the server has no images on disk: load the stored demo fields' images and
    Gaia neighbours in the background, one after the other, so clicking a star in them is quick.
    Starts 90 s after start-up, once the new instance has passed Render's health checks."""
    def start():
        for f in sorted(pl.RESULTS_DIR.glob("*.json")):
            if f.name.startswith(("arch_", "mv_", "gaia_")):
                continue
            pl.prefetch_cutouts(f.stem)
    t = threading.Timer(90, start)
    t.daemon = True
    t.start()


@app.get("/api/targets")
def targets():
    return [{k: t[k] for k in ("id", "name", "ra", "dec", "pmra", "pmdec", "ref_epoch", "kind", "note",
                                "description", "interesting_fact", "story", "sources") if k in t}
            for t in cat.TARGETS]


@app.get("/api/resolve")
def resolve(q: str = Query(..., min_length=1)):
    try:
        r = cat.resolve(q)
    except cat.ResolverDown:
        raise HTTPException(503, "The name services (SIMBAD, CDS Sesame) cannot be reached right now. "
                                 "Please enter coordinates instead.")
    if r is None:
        raise HTTPException(404, f"No object called '{q}' was found in SIMBAD or CDS Sesame.")
    return r


@app.get("/api/object-info")
def object_info(ra: float = Query(..., ge=0.0, lt=360.0),
                dec: float = Query(..., ge=-90.0, le=90.0),
                radius_arcsec: float = Query(12.0, ge=1.0, le=60.0)):
    """Identify the nearest catalogued object to a clicked sky position."""
    return cat.object_info(ra, dec, radius_arcsec)


@app.post("/api/frames")
def frames(req: FramesRequest):
    params = req.model_dump()
    params_for_key = {k: v for k, v in params.items() if k not in pl.KEY_EXCLUDE}
    key = pl.job_key(params_for_key)
    # A sharper (more images per visit) result of the same field is always good enough, and so is
    # one covering all dates (the page filters visits by date itself).
    variants = [params_for_key | {"max_per_cell": 8, "budget": 260, "date_start": None, "date_end": None},
                params_for_key | {"max_per_cell": 8, "budget": 260}, params_for_key]
    for v in variants:
        k = pl.job_key(v)
        if v["max_per_cell"] >= params["max_per_cell"] and pl.cached_result(k):
            return {"status": "done", "result_key": k}
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {"status": "running", "stage": "queued", "done": 0, "total": 1,
                        "message": "Queued...", "params": params}
    EXECUTOR.submit(_run, job_id, params_for_key | {"name": params.get("name"), "priority_dets": params.get("priority_dets")})
    return {"status": "running", "job_id": job_id}


@app.post("/api/moving")
def moving(req: MovingRequest):
    params = req.model_dump()
    key = "mv_" + pl.job_key(params)
    if pl.cached_result(key):
        return {"status": "done", "result_key": key}
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {"status": "running", "stage": "queued", "done": 0, "total": 1,
                        "message": "Queued...", "params": params}
    EXECUTOR.submit(_run, job_id, params, mv.run_moving_job)
    return {"status": "running", "job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    with JOBS_LOCK:
        j = JOBS.get(job_id)
        if not j:
            raise HTTPException(404, "Unknown job")
        return {k: v for k, v in j.items() if k not in ("params", "partial")}


@app.get("/api/jobs/{job_id}/partial")
def job_partial(job_id: str):
    """Frames finished so far (first and last visit first), so the page can start blinking early."""
    with JOBS_LOCK:
        j = JOBS.get(job_id)
        part = j.get("partial") if j else None
    if part is None:
        raise HTTPException(404, "No partial result yet")
    return JSONResponse(part)


@app.get("/api/result/{key}")
def result(key: str):
    r = pl.cached_result(key)
    if not r:
        raise HTTPException(404, "Result not found")
    if r.get("mode") != "moving":
        pl.prefetch_cutouts(key)          # so clicking a star in this field is quick
    return JSONResponse(r)


@app.get("/api/spectrum/{key}")
def spectrum(key: str, ra: float, dec: float):
    """Spectrum + light curve at any position inside an already loaded field."""
    res = pl.cached_result(key)
    cutouts = pl.cutouts_for(key, {})
    if not res or not cutouts:
        raise HTTPException(404, "Field not loaded")
    nbrs = pl.gaia_neighbors(key, res["grid"]["crval"][0], res["grid"]["crval"][1],
                             res["fov_arcmin"], res["epochs"])
    return pl.spectrum_and_lightcurve(cutouts, ra=ra, dec=dec, neighbors_by_epoch=nbrs, method="psf")


@app.get("/api/index")
def index_info():
    """Status of our own SPHEREx footprint index (how many images, when it was built)."""
    import sky_index
    return sky_index.info()


@app.get("/api/track/{key}/{epoch}")
def track_images(key: str, epoch: int):
    """Single images of one visit with the Earth's position, for the parallax tracker."""
    import tracker
    r = tracker.visit_images(key, epoch)
    if r is None:
        raise HTTPException(404, "Field or visit not loaded")
    return JSONResponse(r)


@app.get("/api/archival/{key}")
def archival(key: str):
    """2MASS (~2000) and AllWISE (2010) frames of an already loaded field, on the same grid."""
    import archival as ar
    if not pl.cached_result(key):
        raise HTTPException(404, "Field not loaded")
    return ar.archival_frames(key)


@app.get("/api/gaia")
def gaia(ra: float, dec: float, radius_deg: float = Query(..., gt=0, le=0.3),
         jyears: str = Query(...)):
    return cat.gaia_sources(ra, dec, radius_deg, [float(x) for x in jyears.split(",")])


@app.get("/api/asteroids")
def asteroids(ra: float, dec: float, half_width_deg: float = Query(..., gt=0, le=0.3),
              mjds: str = Query(...)):
    out = []
    for m in [float(x) for x in mjds.split(",")][:24]:
        try:
            out.append({"mjd": m, "objects": cat.known_small_bodies(ra, dec, half_width_deg, m)})
        except Exception as err:
            out.append({"mjd": m, "objects": [], "error": str(err)[:200]})
    return out


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
