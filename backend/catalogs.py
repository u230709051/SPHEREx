"""
Name resolution, proper-motion propagation, Gaia DR3 overlay and known
Solar System object lookup.

Parts of this file were written with the assistance of an AI coding assistant
(Claude, Anthropic) and reviewed by the team. See README "Use of AI".
"""
from __future__ import annotations

import csv
import io
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from astropy.time import Time

HERE = Path(__file__).resolve().parent
TARGETS = json.loads((HERE / "targets.json").read_text())["targets"]
UA = {"User-Agent": "spherex-timemachine/0.1 (NASA Space Apps 2026 project)"}


def _get(url: str, timeout: float = 30, data: bytes | None = None) -> str:
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


# --------------------------------------------------------------------------- #
# Proper motion
# --------------------------------------------------------------------------- #
def propagate(ra: float, dec: float, pmra: float, pmdec: float,
              ref_epoch: float, jyear: float) -> tuple[float, float]:
    """Linear proper-motion propagation (mas/yr; pmra includes cos(dec))."""
    dt = jyear - ref_epoch
    dec_t = dec + pmdec * dt / 3.6e6
    ra_t = ra + pmra * dt / 3.6e6 / np.cos(np.radians(dec))
    return float(ra_t % 360.0), float(dec_t)


def mjd_to_jyear(mjd: float) -> float:
    return float(Time(mjd, format="mjd").jyear)


# --------------------------------------------------------------------------- #
# Name resolution: built-in table -> SIMBAD (Harvard mirror) -> CDS Sesame
# --------------------------------------------------------------------------- #
def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


class ResolverDown(Exception):
    """No name service could be reached (as opposed to: the name is unknown)."""


def _simbad_harvard(query: str) -> dict | None:
    """SIMBAD mirror at Harvard: still answers when the CDS servers in Strasbourg are down."""
    script = ('output console=off script=off\n'
              'format object "%COO(d;A D;ICRS;J2000;2000)|%PM(A D)"\n'
              f'query id {" ".join(query.split())}')   # one line only: the name goes into a script
    txt = _get("https://simbad.harvard.edu/simbad/sim-script?script=" + urllib.parse.quote(script), timeout=15).strip()
    m = re.fullmatch(r"([\d.]+) +([-+][\d.]+)\|(\S+) +(\S+)", txt)
    if not m:
        return None
    has_pm = m.group(3) != "~"
    return {"name": query, "ra": float(m.group(1)), "dec": float(m.group(2)),
            "pmra": float(m.group(3)) if has_pm else 0.0, "pmdec": float(m.group(4)) if has_pm else 0.0,
            "ref_epoch": 2000.0, "kind": "", "note": "", "source": "SIMBAD (Harvard mirror)"}


def _sesame(query: str) -> dict | None:
    xml = _get("https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?" + urllib.parse.quote(query), timeout=12)
    ra = re.search(r"<jradeg>([^<]+)</jradeg>", xml)
    dec = re.search(r"<jdedeg>([^<]+)</jdedeg>", xml)
    if not (ra and dec):
        return None
    pm = re.search(r"<pmRA>([^<]+)</pmRA>.*?<pmDE>([^<]+)</pmDE>", xml, re.S)
    oname = re.search(r"<oname>([^<]+)</oname>", xml)
    return {"name": oname.group(1) if oname else query,
            "ra": float(ra.group(1)), "dec": float(dec.group(1)),
            "pmra": float(pm.group(1)) if pm else 0.0, "pmdec": float(pm.group(2)) if pm else 0.0,
            "ref_epoch": 2000.0, "kind": "", "note": "", "source": "CDS Sesame"}


def resolve(query: str) -> dict | None:
    """Built-in targets, then SIMBAD, then CDS Sesame (which also knows NED and VizieR names).
    Returns None for an unknown name; raises ResolverDown when no service answered."""
    q = _norm(query)
    for t in TARGETS:
        if q == _norm(t["name"]) or q in (_norm(a) for a in t["aliases"]) or q == t["id"]:
            return {**{k: t[k] for k in ("name", "ra", "dec", "pmra", "pmdec", "ref_epoch", "kind", "note",
                                         "description", "interesting_fact", "story", "sources") if k in t},
                    "source": "built-in"}
    services = (_simbad_harvard, _sesame)
    failed = 0
    for service in services:
        try:
            r = service(query)
        except Exception:
            failed += 1
            continue
        if r:
            return r
    if failed == len(services):
        raise ResolverDown()
    return None


# --------------------------------------------------------------------------- #
# Gaia DR3 (ESA TAP, MAST VO cone search as fallback)
# --------------------------------------------------------------------------- #
def _gaia_esa(ra, dec, radius_deg, gmax):
    q = ("SELECT TOP 3000 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp, teff_gspphot "
         "FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),"
         f"CIRCLE('ICRS',{ra},{dec},{radius_deg})) AND phot_g_mean_mag < {gmax}")
    body = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q}).encode()
    txt = _get("https://gea.esac.esa.int/tap-server/tap/sync", timeout=40, data=body)
    return list(csv.DictReader(io.StringIO(txt)))


def _gaia_mast(ra, dec, radius_deg, gmax):
    url = ("https://gsss.stsci.edu/webservices/vo/CatalogSearch.aspx?"
           f"RA={ra}&DEC={dec}&SR={radius_deg}&CAT=GAIADR3&FORMAT=CSV&MAXOBJ=3000")
    txt = _get(url, timeout=40)
    lines = [l for l in txt.splitlines() if not l.startswith("#")]
    rows = list(csv.DictReader(io.StringIO("\n".join(lines))))
    return [r for r in rows if r.get("phot_g_mean_mag") and float(r["phot_g_mean_mag"]) < gmax]


def gaia_sources(ra: float, dec: float, radius_deg: float, jyears: list[float], gmax: float = 19.0) -> dict:
    """Gaia DR3 sources propagated from J2016.0 to each requested epoch."""
    # Ask ESA and MAST at the same time and use the first good answer: either archive can be slow
    # or down (ESA timed out for minutes on 15 Nov 2026 while MAST answered in ~1.5 s).
    rows, provider = None, None
    pool = ThreadPoolExecutor(max_workers=2)
    futs = {pool.submit(fn, ra, dec, radius_deg, gmax): name
            for name, fn in (("ESA Gaia Archive", _gaia_esa), ("MAST", _gaia_mast))}
    try:
        for fut in as_completed(futs, timeout=45):
            try:
                rows, provider = fut.result(), futs[fut]
                break
            except Exception:
                continue
    except Exception:
        pass                                   # both timed out
    pool.shutdown(wait=False)
    if rows is None:
        return {"provider": None, "sources": [], "error": "Gaia services unreachable"}

    def f(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    out = []
    for r in rows:
        r_ra, r_dec = f(r.get("ra")), f(r.get("dec"))
        if r_ra is None or r_dec is None:
            continue
        pmra, pmdec = f(r.get("pmra")), f(r.get("pmdec"))
        has_pm = pmra is not None and pmdec is not None
        pos = [propagate(r_ra, r_dec, pmra if has_pm else 0, pmdec if has_pm else 0, 2016.0, jy) for jy in jyears]
        out.append({"source_id": r.get("source_id"), "g": f(r.get("phot_g_mean_mag")),
                    "pmra": pmra, "pmdec": pmdec, "parallax": f(r.get("parallax")),
                    "bp_rp": f(r.get("bp_rp")), "teff": f(r.get("teff_gspphot")),
                    "pm_total": float(np.hypot(pmra, pmdec)) if has_pm else None,
                    "positions": pos})
    return {"provider": provider, "sources": out}


# --------------------------------------------------------------------------- #
# Object information at a sky position (SIMBAD)
# --------------------------------------------------------------------------- #
_OTYPE_NAMES = {
    "*": "Star", "Star": "Star", "PM*": "High proper-motion star", "V*": "Variable star",
    "BD*": "Brown dwarf", "WD*": "White dwarf", "**": "Double or multiple star", "EB*": "Eclipsing binary",
    "G": "Galaxy", "Galaxy": "Galaxy", "QSO": "Quasar", "AGN": "Active galaxy nucleus", "PN": "Planetary nebula",
    "Neb": "Nebula", "Cl*": "Star cluster", "Pl": "Planet", "Pl?": "Planet candidate", "Planet": "Planet",
}


def object_info(ra: float, dec: float, radius_arcsec: float = 12.0) -> dict:
    """Return the closest SIMBAD object to a position, without inventing a match."""
    radius_arcsec = min(60.0, max(1.0, float(radius_arcsec)))
    radius_deg = radius_arcsec / 3600.0
    query = ("SELECT TOP 10 main_id, ra, dec, otype, sp_type, plx_value, pmra, pmdec "
             "FROM basic WHERE 1=CONTAINS(POINT('ICRS', ra, dec), "
             f"CIRCLE('ICRS', {float(ra):.8f}, {float(dec):.8f}, {radius_deg:.10f}))")
    body = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}).encode()
    rows = None
    for server in ("simbad.cds.unistra.fr", "simbad.harvard.edu"):
        try:
            rows = list(csv.DictReader(io.StringIO(_get(f"https://{server}/simbad/sim-tap/sync", timeout=25, data=body))))
            break
        except Exception:
            continue
    if rows is None:
        return {"matched": False, "available": False}

    def number(value):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    matches = []
    for row in rows:
        obj_ra, obj_dec = number(row.get("ra")), number(row.get("dec"))
        if obj_ra is None or obj_dec is None:
            continue
        dra = (obj_ra - ra + 180.0) % 360.0 - 180.0
        separation = float(np.hypot(dra * np.cos(np.radians((obj_dec + dec) / 2.0)), obj_dec - dec) * 3600.0)
        matches.append((separation, row, obj_ra, obj_dec))
    if not matches:
        return {"matched": False, "available": True, "radius_arcsec": radius_arcsec}

    separation, row, obj_ra, obj_dec = min(matches, key=lambda item: item[0])
    parallax = number(row.get("plx_value")); pmra, pmdec = number(row.get("pmra")), number(row.get("pmdec"))
    raw_type = (row.get("otype") or "").strip(); simbad_id = (row.get("main_id") or "SIMBAD object").strip()
    return {
        "matched": True, "name": simbad_id.removeprefix("NAME "), "simbad_id": simbad_id,
        "type": _OTYPE_NAMES.get(raw_type, raw_type or "Catalogued object"),
        "spectral_type": (row.get("sp_type") or "").strip() or None,
        "ra": obj_ra, "dec": obj_dec, "separation_arcsec": separation, "parallax": parallax,
        "distance_pc": 1000.0 / parallax if parallax is not None and parallax > 0 else None,
        "pmra": pmra, "pmdec": pmdec,
        "pm_total": float(np.hypot(pmra, pmdec)) if pmra is not None and pmdec is not None else None,
        "source": "SIMBAD",
        "note": ("This planet is a catalogue association at the host star's position; SPHEREx does not spatially resolve it from the star.")
                if raw_type in {"Pl", "Pl?", "Planet"} else None,
    }


# --------------------------------------------------------------------------- #
# Known Solar System objects (JPL Small-Body Identification API)
# --------------------------------------------------------------------------- #
def _sexa_to_deg(ra_s: str, dec_s: str) -> tuple[float, float]:
    h, m, s = (float(x) for x in re.split(r"[: ]+", ra_s.strip()))
    sign = -1 if dec_s.strip().startswith("-") else 1
    d, dm, ds = (abs(float(x)) for x in re.split(r"[: '\"]+", dec_s.strip().lstrip("+-")) if x)
    return 15 * (h + m / 60 + s / 3600), sign * (d + dm / 60 + ds / 3600)


def _fmt_ra(ra):
    h = ra / 15
    return f"{int(h):02d}-{int(h * 60 % 60):02d}-{h * 3600 % 60:05.2f}"


def _fmt_dec(dec):
    s = "M" if dec < 0 else ""
    d = abs(dec)
    return f"{s}{int(d):02d}-{int(d * 60 % 60):02d}-{d * 3600 % 60:04.1f}"


def known_small_bodies(ra: float, dec: float, half_width_deg: float, mjd: float) -> list[dict]:
    t = Time(mjd, format="mjd").to_datetime().strftime("%Y-%m-%d_%H:%M:%S")
    # Single pass (fast, ~arcsec-level accuracy is plenty at 6" pixels); two-pass often times out.
    url = ("https://ssd-api.jpl.nasa.gov/sb_ident.api?mpc-code=500"
           f"&obs-time={t}&fov-ra-center={_fmt_ra(ra)}&fov-dec-center={_fmt_dec(dec)}"
           f"&fov-ra-hwidth={half_width_deg:.4f}&fov-dec-hwidth={half_width_deg:.4f}")
    data = json.loads(_get(url, timeout=60))
    fields = data.get("fields_second") or data.get("fields_first") or []
    rows = data.get("data_second_pass") or data.get("data_first_pass") or []
    out = []
    for r in rows:
        rec = dict(zip(fields, r))
        try:
            ra_d, dec_d = _sexa_to_deg(rec["Astrometric RA (hh:mm:ss)"], rec["Astrometric Dec (dd mm'ss\")"])
        except Exception:
            continue
        try:
            vmag = float(rec.get("Visual magnitude (V)"))
        except (TypeError, ValueError):
            vmag = None
        # The single-pass list covers a padded region; keep what is inside the field and
        # bright enough for SPHEREx single exposures (~V 21).
        dra = (ra_d - ra + 180) % 360 - 180
        if abs(dra * np.cos(np.radians(dec))) > half_width_deg or abs(dec_d - dec) > half_width_deg:
            continue
        if vmag is not None and vmag > 21.0:
            continue
        out.append({"name": rec.get("Object name", "").strip(), "ra": ra_d, "dec": dec_d, "vmag": vmag,
                    "ra_rate": rec.get("RA rate (\"/h)"), "dec_rate": rec.get("Dec rate (\"/h)")})
    return sorted(out, key=lambda o: o["vmag"] if o["vmag"] is not None else 99)
