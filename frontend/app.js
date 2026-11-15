/*
 * SPHEREx Time Machine – frontend.
 * Parts of this file were written with the assistance of an AI coding assistant
 * (Claude, Anthropic) and reviewed by the team. See README "Use of AI".
 */
"use strict";

const DETS = ["D1", "D2", "D3", "D4", "D5", "D6"];
const DET_WL = { D1: "0.75–1.1", D2: "1.1–1.6", D3: "1.6–2.4", D4: "2.4–3.8", D5: "3.8–4.4", D6: "4.4–5.0" };
const DET_COLORS = { D1: "#7aa2ff", D2: "#5ad1ff", D3: "#5ef0b0", D4: "#d6e05a", D5: "#ffb547", D6: "#ff6b6b" };
const FEATURES = [
  { lo: 1.30, hi: 1.50, label: "H₂O", kind: "mol" }, { lo: 1.75, hi: 2.05, label: "H₂O", kind: "mol" },
  { lo: 2.60, hi: 2.95, label: "H₂O", kind: "mol" }, { lo: 1.60, hi: 1.75, label: "CH₄", kind: "mol" },
  { lo: 2.15, hi: 2.45, label: "CH₄", kind: "mol" }, { lo: 3.15, hi: 3.55, label: "CH₄ (3.3)", kind: "mol" },
  { lo: 4.20, hi: 4.35, label: "CO₂", kind: "mol" }, { lo: 4.50, hi: 4.80, label: "CO", kind: "mol" },
];
const LINES = [[1.282, "Paβ"], [1.875, "Paα"], [2.166, "Brγ"], [3.30, "PAH"], [4.052, "Brα"]];
const THREE_I_PROFILE = {
  description: "3I/ATLAS is an active comet on a hyperbolic path that originated outside the Solar System. It is the third confirmed interstellar object observed passing through our planetary neighbourhood.",
  interesting_fact: "NASA reports that SPHEREx detected infrared emission from dust, water, organic molecules and carbon dioxide in the comet's coma.",
  story: "The NASA-funded ATLAS survey in Chile reported it on July 1, 2025. The “3I” designation means it is the third confirmed interstellar object; “ATLAS” credits the discovering survey.",
  sources: [{ label: "NASA 3I/ATLAS", url: "https://science.nasa.gov/solar-system/comets/3i-atlas/" }],
};

const $ = (id) => document.getElementById(id);
const S = {
  result: null, key: null, z: new Map(), epochs: [], cur: 0, playing: true, timer: null,
  mode: "blink", dets: new Set(["D5", "D6"]), display: [], limits: null,
  gaia: null, ast: null, spec: null, specLabel: null, target: null, fov: 5, pending: null,
  embed: false, objectRequest: 0, objectCloseTimer: null, selectedObject: null,
};

// ---------------------------------------------------------------- helpers
const fmt = (x, d = 2) => (x == null || !isFinite(x) ? "–" : Number(x).toFixed(d));
function sexa(deg, isRa) {
  // round once, in units of the last digit shown, so 59.99 s never prints as "60.0"
  const dp = isRa ? 2 : 1, f = 10 ** dp, day = 86400 * f;
  let tot = Math.round((isRa ? deg / 15 : Math.abs(deg)) * 3600 * f);
  if (isRa) tot = ((tot % day) + day) % day;
  const a = Math.floor(tot / (3600 * f)), b = Math.floor((tot % (3600 * f)) / (60 * f)), c = (tot % (60 * f)) / f;
  const s = `${String(a).padStart(2, "0")}:${String(b).padStart(2, "0")}:${c.toFixed(dp).padStart(dp + 3, "0")}`;
  return isRa ? s : (deg < 0 ? "−" : "+") + s;
}
function parseCoords(text) {
  const t = text.trim().replace(/[hdms°′″'"]/g, " ").replace(/,/g, " ").replace(/\s+/g, " ");
  const parts = t.split(" ");
  if (parts.length === 2 && parts.every((p) => /^[-+]?\d+(\.\d+)?$/.test(p))) {
    return { ra: +parts[0], dec: +parts[1] };
  }
  const sx = text.trim().match(/^(\d{1,2})[: h](\d{1,2})[: m](\d{1,2}(?:\.\d+)?)s?\s*,?\s*([-+]?\d{1,2})[: d°](\d{1,2})[: m′'](\d{1,2}(?:\.\d+)?)/);
  if (sx) {
    if ([sx[2], sx[3], sx[5], sx[6]].some((v) => +v >= 60)) return { ra: NaN, dec: NaN };   // minutes/seconds must be < 60
    const ra = 15 * (+sx[1] + sx[2] / 60 + sx[3] / 3600);
    const sgn = sx[4].startsWith("-") ? -1 : 1;
    const dec = sgn * (Math.abs(+sx[4]) + sx[5] / 60 + sx[6] / 3600);
    return { ra, dec };
  }
  return null;
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))).detail;
    throw new Error(Array.isArray(d) ? d.map((x) => `${(x.loc || []).slice(-1)[0]}: ${x.msg}`).join("; ") : d || r.statusText);
  }
  return r.json();
}
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function decodeF32(b64) {
  const bin = atob(b64), buf = new ArrayBuffer(bin.length), u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(buf);
}

// ---------------------------------------------------------------- WCS (TAN)
const D2R = Math.PI / 180;
function world2pix(ra, dec) {
  const g = S.result.grid, a0 = g.crval[0] * D2R, d0 = g.crval[1] * D2R;
  const a = ra * D2R, d = dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc / D2R;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / D2R;
  return [g.crpix[0] + xi / g.cdelt[0] - 1, g.crpix[1] + eta / g.cdelt[1] - 1]; // 0-based
}
function pix2world(x, y) {
  const g = S.result.grid, a0 = g.crval[0] * D2R, d0 = g.crval[1] * D2R;
  const xi = (x + 1 - g.crpix[0]) * g.cdelt[0] * D2R, eta = (y + 1 - g.crpix[1]) * g.cdelt[1] * D2R;
  const den = Math.cos(d0) - eta * Math.sin(d0);
  const ra = (a0 + Math.atan2(xi, den)) / D2R;
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) / D2R;
  return [(ra + 360) % 360, dec];
}

// ---------------------------------------------------------------- frames
function normaliseFrames() {
  S.z.clear();
  for (const f of [...S.result.frames, ...(S.arch ? S.arch.frames : [])]) {
    const a = decodeF32(f.data);
    const fin = Array.from(a).filter(Number.isFinite).sort((p, q) => p - q);
    const med = percentile(fin, 50);
    const mad = percentile(fin.map((v) => Math.abs(v - med)).sort((p, q) => p - q), 50) * 1.4826 || 1;
    const z = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) z[i] = (a[i] - med) / mad;
    S.z.set(`${f.epoch}|${f.det}`, z);
  }
}
function composite(ep, dets) {
  const [ny, nx] = S.result.grid.shape, out = new Float32Array(nx * ny), cnt = new Uint8Array(nx * ny);
  let any = false;
  // Archival epochs (2MASS/WISE, ids < 0) have only two bands: if none of the selected
  // detectors is covered, show their closest available band instead of an empty frame.
  if (ep < 0 && !dets.some((d) => S.z.has(`${ep}|${d}`))) dets = DETS;
  for (const d of dets) {
    const z = S.z.get(`${ep}|${d}`);
    if (!z) continue;
    any = true;
    for (let i = 0; i < z.length; i++) if (Number.isFinite(z[i])) { out[i] += z[i]; cnt[i]++; }
  }
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? out[i] / Math.sqrt(cnt[i]) : NaN;
  return any ? out : null;
}
function medianOthers(arrs, skip) {
  const n = arrs.find(Boolean).length, out = new Float32Array(n), tmp = [];
  for (let i = 0; i < n; i++) {
    tmp.length = 0;
    arrs.forEach((a, k) => { if (k !== skip && a && Number.isFinite(a[i])) tmp.push(a[i]); });
    tmp.sort((p, q) => p - q);
    out[i] = tmp.length ? tmp[tmp.length >> 1] : NaN;
  }
  return out;
}
// ---------------------------------------------------------------- date range
function dateRange() { return { from: $("dFrom").value || null, to: $("dTo").value || null }; }
function inRange(e) {   // a visit (or archival epoch) overlapping the chosen dates
  const r = dateRange();
  return (!r.from || e.date_end >= r.from) && (!r.to || e.date_start <= r.to);
}
function rangeNote(text) { $("rangeNote").hidden = !text; $("rangeNote").textContent = text || ""; }
function onRangeChange() {
  updateDatesSummary();
  setHash();
  if (!S.result || isMoving()) return;
  const dr = S.result.date_range, r = dateRange();
  // the field was loaded for a narrower range: widen it by loading again
  if (dr && ((dr[0] && (!r.from || r.from < dr[0])) || (dr[1] && (!r.to || r.to > dr[1])))) return loadTarget(S.target, S.fov);
  rebuildDisplay(); plotSpectrum(); plotLightcurve(); showMotionBadge();
}
function setQmode(v) {   // "Sky position | Moving object" toggle drives the (hidden) select the code reads
  $("qmode").value = v;
  document.querySelectorAll(".seg button").forEach((b) => {
    const on = b.dataset.q === v; b.classList.toggle("on", on); b.setAttribute("aria-checked", on);
  });
  $("q").placeholder = v === "sso" ? "Asteroid or comet name or number" : "RA Dec or object name";
  $("searchHint").textContent = v === "sso" ? "e.g. Ceres, 2024 YR4, 3I – followed through every SPHEREx image of it"
    : "RA Dec in degrees (269.45 4.69) or hh:mm:ss ±dd:mm:ss (08:55:10.8 −07:14:42), or an object name";
}
function updateDatesSummary() {
  const r = dateRange(), el = $("datesSummary");
  el.textContent = r.from || r.to ? `Dates: ${r.from || "…"} → ${r.to || "…"}` : "Date range";
  el.classList.toggle("set", Boolean(r.from || r.to));
}
function useArchival() {
  return Boolean(S.arch && S.arch.epochs.length && $("ovArch").checked && (S.mode === "blink" || S.mode === "diff") && !isMoving());
}
function rebuildDisplay() {
  if (!S.result) return;
  const curId = S.epochs[S.cur]?.epoch;
  const r = dateRange(), ranged = !isMoving() && (r.from || r.to);
  let sph = ranged ? S.sph.filter(inRange) : S.sph;
  let arch = useArchival() ? (ranged ? S.arch.epochs.filter(inRange) : S.arch.epochs) : [];
  if (ranged && !sph.length && !arch.length) {
    rangeNote(`No visits between ${r.from || "the start"} and ${r.to || "today"}. This field was observed on ${S.sph.map((e) => e.date_start).join(", ")}; showing all.`);
    sph = S.sph; arch = useArchival() ? S.arch.epochs : [];
  } else if (ranged) {
    const one = sph.length + arch.length === 1 ? " Only one visit in this range, so nothing can change: widen the dates to compare visits." : " Clear the dates to see all.";
    rangeNote(`Dates ${r.from || "…"} → ${r.to || "…"}: ${sph.length} of ${S.sph.length} SPHEREx visits${arch.length ? ` + ${arch.map((e) => e.label).join(" + ")}` : ""}.${one}`);
  } else rangeNote(null);
  S.epochs = [...arch, ...sph];
  S.cur = Math.max(0, S.epochs.findIndex((e) => e.epoch === curId));
  buildTimeline();
  const eps = S.epochs.map((e) => e.epoch);
  const dets = [...S.dets];
  if (S.mode === "color") {
    const ch = [["D5", "D6"], ["D3", "D4"], ["D1", "D2"]];
    S.display = eps.map((ep) => ch.map((c) => composite(ep, c)));
  } else if (S.mode === "cdiff") {
    S.display = eps.map((ep) => {
      const a = composite(ep, ["D5", "D6"]), b = composite(ep, ["D4"]);
      if (!a || !b) return [null];
      const o = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i];
      return [o];
    });
  } else {
    const base = eps.map((ep) => composite(ep, dets));
    if (S.mode === "stack") {
      const valid = base.filter((a, i) => a && !S.epochs[i].archival);
      const st = valid.length ? medianOthers(valid, -1) : null;
      S.display = base.map(() => [st]);
    } else if (S.mode === "diff") {
      S.display = base.map((a, k) => {
        if (!a) return [null];
        // reference = median of the *SPHEREx* visits only (never mix instruments in the template)
        const m = medianOthers(base.map((b, i) => (S.epochs[i].archival ? null : b)), k), o = new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) o[i] = a[i] - m[i];
        return [o];
      });
    } else S.display = base.map((a) => [a]);
  }
  if (S.mode === "track") S.display = trackDisplay();
  findCandidates();
  computeLimits();
  render();
}
/* Automatic candidate detection on the difference images (visit minus median of the others):
   - "mover?"    a positive peak with a negative trough next to it in the same visit (dipole)
   - "variable?" a persistent source whose brightness changed
   - "single"    something present in one visit only (asteroid, transient, or an artifact)      */
function findCandidates() {
  S.cands = [];
  if (!S.result || isMoving() || S.epochs.length < 2) return;
  if (S.result.partial === "preview") return;   // single images: cosmic rays are not rejected yet
  const [ny, nx] = S.result.grid.shape, dets = [...S.dets];
  const base = S.epochs.map((e) => (e.archival ? null : composite(e.epoch, dets)));   // SPHEREx visits only
  if (base.filter(Boolean).length < 2) return;
  const diffs = base.map((a, k) => {
    if (!a) return null;
    const m = medianOthers(base, k), o = new Float32Array(a.length), fin = [];
    for (let i = 0; i < a.length; i++) { o[i] = a[i] - m[i]; if (Number.isFinite(o[i])) fin.push(Math.abs(o[i])); }
    fin.sort((p, q) => p - q);
    return { o, m, sig: 1.4826 * percentile(fin, 50) || 1 };
  });
  // Around a saturated target the residuals are dominated by its changing wings: do not search there.
  const pts = S.result.points || [], satTarget = pts.length && pts.filter((p) => p.saturated).length / pts.length > 0.3;
  const tpix = S.epochs.map((e) => world2pix(e.target_ra, e.target_dec));
  const satFlux = pts.filter((p) => p.saturated).map((p) => p.flux_mjy).sort((a, b) => a - b);
  S.candOff = Boolean(satTarget && satFlux.length && satFlux[satFlux.length >> 1] > 3000);   // > ~3 Jy: halo fills the field
  if (S.candOff) { S.cands = S.epochs.map(() => []); return; }
  const nImg = new Map(S.result.frames.map((f) => [`${f.epoch}|${f.det}`, f.n]));
  S.cands = diffs.map((d, k) => {
    if (!d) return [];
    // Visits built from fewer than 3 images per detector have no cosmic-ray rejection: skip them.
    const ns = dets.map((dt) => nImg.get(`${S.epochs[k].epoch}|${dt}`)).filter((n) => n != null);
    if (!ns.length || Math.min(...ns) < 3) return [];
    const { o, m, sig } = d, found = [];
    for (let y = 3; y < ny - 3; y++) for (let x = 3; x < nx - 3; x++) {
      const i = y * nx + x, v = o[i];
      if (!(v > 5 * sig)) continue;
      let isMax = true, second = -Infinity, bad = false, mMax = Math.abs(m[i]);
      for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const u = o[(y + dy) * nx + x + dx];
        if (!Number.isFinite(u)) { if (Math.abs(dx) < 2 && Math.abs(dy) < 2) bad = true; continue; }
        if (u > v) { isMax = false; break; }
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) { second = Math.max(second, u); mMax = Math.max(mMax, Math.abs(m[(y + dy) * nx + x + dx])); }
      }
      // reject single-pixel spikes (cosmic rays) and small residuals of bright static stars
      if (!isMax || bad || second < 2 * sig || v < 0.3 * mMax) continue;
      if (satTarget && Math.hypot(x - tpix[k][0], y - tpix[k][1]) < 10) continue;
      let wide = 0;   // wings of a much brighter star nearby?
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const u = m[(y + dy) * nx + x + dx];
        if (Number.isFinite(u) && u > wide) wide = u;
      }
      if (v < 0.08 * wide) continue;
      if (satTarget && wide > 15) continue;   // inside the halo of the saturated target: only trust faint-sky detections
      let trough = 0, tDist = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const u = o[(y + dy) * nx + x + dx], r = Math.hypot(dx, dy);
        if (r >= 1 && r <= 3.2 && Number.isFinite(u) && u < trough) { trough = u; tDist = r; }
      }
      let kind = "single";
      if (trough < -4 * sig && -trough > 0.35 * v) kind = "mover";
      else if (mMax > 6) kind = "variable";
      else if (diffs.some((e, j) => j !== k && e && Math.abs(e.o[i]) > 4 * e.sig)) kind = "variable";
      found.push({ x, y, v: v / sig, kind });
    }
    return found.sort((a, b) => b.v - a.v).slice(0, 8);
  });
}
function computeLimits() {
  const lo = +$("lo").value, hi = +$("hi").value, sym = S.mode === "diff" || S.mode === "cdiff";
  const nch = S.display[0]?.length || 1;
  S.limits = [];
  for (let c = 0; c < nch; c++) {
    const vals = [];
    for (const d of S.display) {
      const a = d[c];
      if (!a) continue;
      for (let i = 0; i < a.length; i += 3) if (Number.isFinite(a[i])) vals.push(sym ? Math.abs(a[i]) : a[i]);
    }
    vals.sort((p, q) => p - q);
    S.limits.push(sym ? [-percentile(vals, hi), percentile(vals, hi)] : [percentile(vals, lo), percentile(vals, hi)]);
  }
}
function stretch(v, [a, b], k) {
  if (!Number.isFinite(v)) return NaN;
  let x = (v - a) / (b - a || 1);
  x = Math.min(1, Math.max(0, x));
  return k > 0 ? Math.asinh(k * x) / Math.asinh(k) : x;
}

// ---------------------------------------------------------------- rendering
const off = document.createElement("canvas");
function render() {
  const cv = $("img"), ctx = cv.getContext("2d");
  ctx.fillStyle = "#05080d";
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!S.result || !S.display.length) return drawOverlay();
  const [ny, nx] = S.result.grid.shape, chans = S.display[S.cur];
  off.width = nx; off.height = ny;
  const octx = off.getContext("2d"), img = octx.createImageData(nx, ny);
  const k = +$("asinh").value, inv = $("invert").checked, sym = S.mode === "diff" || S.mode === "cdiff";
  const kk = sym ? 0 : k;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const src = y * nx + x, dst = ((ny - 1 - y) * nx + x) * 4;
      if (chans.length === 3) {
        for (let c = 0; c < 3; c++) {
          const a = chans[c];
          let v = a ? stretch(a[src], S.limits[c], kk) : 0;
          if (!Number.isFinite(v)) v = 0;
          img.data[dst + c] = Math.round(255 * v);   // colour is never inverted (would swap hues)
        }
      } else {
        let v = chans[0] ? stretch(chans[0][src], S.limits[0], kk) : NaN;
        if (!Number.isFinite(v)) { img.data[dst] = 40; img.data[dst + 1] = 20; img.data[dst + 2] = 30; img.data[dst + 3] = 255; continue; }
        const g = Math.round(255 * (inv ? 1 - v : v));
        img.data[dst] = img.data[dst + 1] = img.data[dst + 2] = g;
      }
      img.data[dst + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const v = view();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, v.sx, v.sy, v.sw, v.sw, 0, 0, cv.width, cv.height);
  const e = S.epochs[S.cur];
  if (isMoving()) {
    $("epochLabel").textContent = S.mode === "stack"
      ? `Stack of ${S.epochs.length} frames (shift-and-add on the object)`
      : `${e.date_start} UT · ${e.dets[0]} · ${e.geo_au != null ? e.geo_au.toFixed(2) + " au from Earth" : ""}${e.vmag != null ? " · V≈" + e.vmag.toFixed(1) : ""}`;
  } else {
    $("epochLabel").textContent = e.archival ? `${e.label} · ${e.date_start.slice(0, 4)} · ${archBands(e)} (archival${S.mode === "diff" ? ", minus SPHEREx median" : ""})`
      : S.mode === "stack" ? `Stack of all ${S.epochs.length} visits`
      : S.mode === "track" ? `${e.date_start} → ${e.date_end.slice(5)} · ${trackLabel(e.epoch)}`
      : `${e.date_start}${e.date_end !== e.date_start ? " → " + e.date_end.slice(5) : ""} · ${e.n_images} images · ${S.mode === "color" ? "colour" : S.mode === "cdiff" ? "D5+D6 − D4" : [...S.dets].join("+")}${S.mode === "diff" ? " − median" : ""}`;
  }
  document.querySelectorAll(".timeline button").forEach((b, i) => b.classList.toggle("cur", i === S.cur));
  if (S.mode === "track") trkNote();   // the drift depends on the visit on screen
  drawOverlay();
}
function view() {
  const [ny, nx] = S.result.grid.shape, zoom = +$("zoom").value, sw = nx / zoom;
  return { sx: (nx - sw) / 2, sy: (ny - sw) / 2, sw, scale: $("img").width / sw, nx, ny };
}
function toCanvas(x, y) {
  const v = view();
  return [(x + 0.5 - v.sx) * v.scale, (v.ny - 1 - y + 0.5 - v.sy) * v.scale];
}
function fromCanvas(cx, cy) {
  const v = view();
  return [cx / v.scale + v.sx - 0.5, v.ny - 1 - (cy / v.scale + v.sy - 0.5)];
}
function drawOverlay() {
  const cv = $("overlay"), ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!S.result) return;
  const v = view(), px = v.scale;
  if ($("ovBorder").checked && S.cur === 0) {
    ctx.setLineDash([10, 6]); ctx.strokeStyle = "#ffb547"; ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, cv.width - 4, cv.height - 4); ctx.setLineDash([]);
  }
  if (isMoving()) {   // frames are centred on the object: just mark the centre
    if ($("ovTarget").checked) {
      const c = $("overlay").width / 2, r = Math.max(10, px * 2.2);
      ctx.strokeStyle = "#c58cff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c, c, r, 0, 2 * Math.PI); ctx.stroke();
    }
    return;
  }
  if ($("ovCand").checked && (S.mode === "blink" || S.mode === "diff") && S.cands && S.cands[S.cur]) {
    const style = { mover: ["#ff6bd6", "mover?"], variable: ["#5ad1ff", "variable?"], single: ["#ffd25a", "one visit only"] };
    ctx.font = "11px system-ui"; ctx.lineWidth = 1.5;
    for (const c of S.cands[S.cur]) {
      const [x, y] = toCanvas(c.x, c.y), r = Math.max(8, px * 1.8), [col, label] = style[c.kind];
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
      ctx.fillText(`${label} ${c.v.toFixed(0)}σ`, x - r, y - r - 3);
    }
  }
  if ($("ovGaia").checked && S.gaia) {
    for (const s of S.gaia.sources) {
      const p = gaiaPos(s, S.epochs[S.cur]);
      const fast = s.pm_total && s.pm_total > 150;
      if (!p || (!fast && s.g != null && s.g > 18)) continue;   // declutter: SPHEREx single visits reach ~G 18
      const [x, y] = toCanvas(...world2pix(p[0], p[1]));
      ctx.strokeStyle = fast ? "#ff6bd6" : "rgba(57,217,138,.7)"; ctx.lineWidth = fast ? 2 : 1;
      ctx.beginPath(); ctx.arc(x, y, fast ? Math.max(6, px * 1.6) : Math.max(2.5, px * 0.55), 0, 2 * Math.PI); ctx.stroke();
      if (fast) { // arrow = motion over 5 years
        const q = p, ddeg = (s.pmdec * 5) / 3.6e6, rdeg = (s.pmra * 5) / 3.6e6 / Math.cos(q[1] * D2R);
        const [x2, y2] = toCanvas(...world2pix(q[0] + rdeg, q[1] + ddeg));
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
  }
  if ($("ovAst").checked && S.ast) {
    const list = S.ast[S.sphIdx.get(S.epochs[S.cur].epoch)]?.objects || [];
    ctx.font = "12px system-ui"; ctx.fillStyle = "#ffd25a"; ctx.strokeStyle = "#ffd25a"; ctx.lineWidth = 1.5;
    for (const o of list) {
      const [x, y] = toCanvas(...world2pix(o.ra, o.dec)), r = Math.max(6, px * 1.3);
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.stroke();
      ctx.fillText(o.name.split(" (")[0], x + r + 2, y - 2);
    }
  }
  if ($("ovTarget").checked && S.target) {
    const pts = S.epochs.map((e) => toCanvas(...world2pix(e.target_ra, e.target_dec)));
    ctx.strokeStyle = "rgba(79,179,255,.6)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    pts.forEach(([x, y], i) => { ctx.fillStyle = i === S.cur ? "#4fb3ff" : "rgba(79,179,255,.5)"; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill(); });
    const [x, y] = pts[S.cur], r = Math.max(9, px * 2.2);
    ctx.strokeStyle = "#4fb3ff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
  }
  ctx.strokeStyle = ctx.fillStyle = "#ffd25a"; ctx.lineWidth = 1.5; ctx.font = "11px system-ui";   // saved candidates
  const [ra0, dec0] = S.result.grid.crval;
  for (const c of loadSaved()) {
    // only candidates in this field: far-away points can project into the canvas through the TAN projection
    if (Math.hypot((((c.ra - ra0 + 540) % 360) - 180) * Math.cos(dec0 * D2R), c.dec - dec0) > 1) continue;
    const [x, y] = toCanvas(...world2pix(c.ra, c.dec));
    if (x > 0 && y > 0 && x < cv.width && y < cv.height) { ctx.strokeRect(x - 7, y - 7, 14, 14); ctx.fillText("★", x + 9, y - 6); }
  }
  if (S.specLabel && S.specLabel.ra != null) {
    const [x, y] = toCanvas(...world2pix(S.specLabel.ra, S.specLabel.dec));
    ctx.strokeStyle = "#ffb547"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 10, y);
    ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 10); ctx.stroke();
  }
}

// ---------------------------------------------------------------- playback
function step(d) { if (!S.epochs.length) return; S.cur = (S.cur + d + S.epochs.length) % S.epochs.length; render(); }
function play(on) {
  S.playing = on; $("playBtn").textContent = on ? "⏸" : "▶︎";
  clearTimeout(S.timer);
  const tick = () => { if (!S.playing) return; step(1); S.timer = setTimeout(tick, +$("speed").value); };
  if (on) S.timer = setTimeout(tick, +$("speed").value);
}

// ---------------------------------------------------------------- loading
function showProgress(on, msg, frac) {
  $("progress").hidden = !on;
  if (msg) $("progressMsg").textContent = msg;
  if (frac != null) $("progressBar").style.width = `${Math.round(frac * 100)}%`;
}
// New fields load at full quality (up to 8 images per visit and detector, ~1 min on the live site).
// Results made with fewer images (QUICK, older links) get a "Sharper images" button.
const QUICK = { max_per_cell: 3, budget: 120 }, FULL = { max_per_cell: 8, budget: 260 };
function resetView() {   // a new field is loading: nothing of the previous target may stay on screen
  closeObjectCard();
  play(false);
  S.result = null; S.key = null; S.epochs = []; S.sph = []; S.display = []; S.arch = null; S.cands = [];
  $("badges").innerHTML = ""; $("timeline").innerHTML = ""; $("epochLabel").textContent = ""; $("readout").textContent = "";
  $("links").innerHTML = ""; $("warnCard").hidden = true; rangeNote(null); liveStatus(null);
  render();
  clearCharts();
}
function clearCharts() {   // a new field is loading: do not leave the previous target's charts on screen
  S.spec = { points: [], lightcurve: [] };
  $("specTitle").textContent = "Spectrum (waiting for images…)"; $("specReset").hidden = true;
  if (window.Plotly) {
    ["specPlot", "lcPlot"].forEach((id) => Plotly.react(id, [], { ...PLOT_LAYOUT, annotations: [{ xref: "paper", yref: "paper", x: 0.5, y: 0.5,
      showarrow: false, text: "waiting for the first measurements…", font: { size: 11, color: "#8e9bb3" } }] }, { displayModeBar: false, responsive: true }));
  }
  S.spec = null;
}
async function loadTarget(t, fov, quality = FULL) {
  resetView();
  S.target = t; S.fov = fov; S.gaia = null; S.ast = null; S.spec = null; S.specLabel = null;
  $("ovAst").checked = false; $("candidates").hidden = true;
  $("empty").hidden = true; $("targetName").textContent = t.name || `${sexa(t.ra, true)} ${sexa(t.dec)}`;
  const pm = Math.hypot(t.pmra || 0, t.pmdec || 0);
  $("targetInfo").textContent = `${t.kind ? t.kind + " · " : ""}RA ${sexa(t.ra, true)} Dec ${sexa(t.dec)} (epoch ${t.ref_epoch || 2000})${pm > 50 ? ` · moves ${(pm / 1000).toFixed(2)}″/yr` : ""}`;
  setHash();
  const body = { ra: t.ra, dec: t.dec, pmra: t.pmra || 0, pmdec: t.pmdec || 0, ref_epoch: t.ref_epoch || 2000,
                 fov_arcmin: fov, ...quality, name: t.name || null,
                 priority_dets: S.dets.size && S.dets.size < 6 ? [...S.dets] : null,
                 date_start: dateRange().from, date_end: dateRange().to };
  runJob("/api/frames", body, "Could not load this field.");
}
async function loadObject(name, fov) {
  resetView();
  S.target = { name, sso: true, pmra: 0, pmdec: 0 }; S.fov = Math.min(fov || 4, 15); setFovOption(S.fov);
  if (name === "3I") Object.assign(S.target, THREE_I_PROFILE);
  S.gaia = null; S.ast = null; S.spec = null; S.specLabel = null; $("ovAst").checked = false;
  $("empty").hidden = true; $("candidates").hidden = true;
  $("targetName").textContent = name;
  $("targetInfo").textContent = "Solar System object · frames centred on the object (stars stream past)";
  setHash();
  const body = { name, fov_arcmin: S.fov, max_frames: 40 };
  if (name === "3I") Object.assign(body, { start: "2025-08-01", end: "2025-12-31" });  // demo: SPHEREx's two 3I/ATLAS campaigns
  const dr = dateRange();
  if (dr.from) body.start = dr.from;
  if (dr.to) body.end = dr.to;
  runJob("/api/moving", body, "Could not track this object.");
}
async function runJob(path, body, failMsg) {
  showProgress(true, "Contacting the SPHEREx archive…", 0.02);
  const token = Symbol(); S.pending = token;
  try {
    let r = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let seen = 0, showing = false;           // partial results already shown (first/last visit, then all visits)
    while (r.status === "running") {
      await new Promise((res) => setTimeout(res, 1000));
      if (S.pending !== token) return;
      const j = await api(`/api/jobs/${r.job_id}`);
      if (j.status === "error") { const e = new Error(j.message); e.candidates = j.candidates; throw e; }
      if (j.status === "done") { r = { status: "done", result_key: j.result_key }; break; }
      if ((j.partial_n || 0) > seen) {
        seen = j.partial_n;
        try {
          const part = await api(`/api/jobs/${r.job_id}/partial`);
          if (S.pending !== token) return;
          onResult(part, { partial: true });
          showing = true;
        } catch { /* the full result will still arrive */ }
      }
      const frac = j.stage === "download" ? 0.1 + 0.75 * (j.done / Math.max(1, j.total)) : j.stage === "process" ? 0.9 : 0.05;
      if (showing) liveStatus(liveText(j));
      else showProgress(true, j.message, frac);
    }
    if (showing) liveStatus("Finishing: spectrum and light curve…");
    else showProgress(true, "Rendering…", 0.97);
    const res = await api(`/api/result/${r.result_key}`);
    if (S.pending !== token) return;
    liveStatus(null);
    onResult(res);
  } catch (err) {
    showProgress(false); liveStatus(null);
    if (S.result && S.result.partial) {        // keep the frames we already have on screen
      $("specTitle").textContent = "Spectrum unavailable";
      $("badges").insertAdjacentHTML("afterbegin", `<span class="badge warn">Stopped early: ${err.message}</span>`);
      return;
    }
    $("empty").hidden = false;
    $("empty").innerHTML = `<p><b>${failMsg}</b><br>${err.message}</p>`;
    if (err.candidates) {
      const box = $("candidates");
      box.hidden = false;
      box.innerHTML = "Did you mean: " + err.candidates.map((c) => `<button data-n="${c.naif}" class="sso">${c.name} <span class="k">${c.type}</span></button>`).join("");
      box.querySelectorAll("button").forEach((b) => (b.onclick = () => loadObject(b.dataset.n, +$("fov").value)));
    }
  }
}
const isMoving = () => S.result && S.result.mode === "moving";
function liveStatus(text) {
  $("liveStatus").hidden = !text;
  if (text) $("liveStatusText").textContent = text;
}
function liveText(j) {
  const r = S.result, what = r && r.partial === "preview" ? "Quick look (1 image per visit) · sharpening" : "Loading the other detectors";
  return j.stage === "download" ? `${what}: ${j.done}/${j.total} images…` : "Measuring the spectrum…";
}
function onResult(res, opt = {}) {
  // Updates of the same field (partial -> more visits -> final) keep the frame being shown and the player state.
  const same = Boolean(S.result && S.result.partial && S.result.key === res.key);
  const curId = same ? S.epochs[S.cur]?.epoch : null;
  S.result = res; S.key = res.key; S.epochs = S.sph = res.epochs; S.arch = null;
  S.cur = same ? Math.max(0, res.epochs.findIndex((e) => e.epoch === curId)) : 0;
  S.sphIdx = new Map(res.epochs.map((e, i) => [e.epoch, i]));
  if (opt.partial) {
    normaliseFrames();
    buildTimeline(); if (!same) buildDetButtons(); rebuildDisplay();
    showProgress(false); $("empty").hidden = true;
    if (!same) S.specLabel = { name: "target", ra: null, dec: null };
    if (S.specLabel && S.specLabel.name === "target") {      // live charts, unless the user is looking elsewhere
      S.spec = { points: res.points || [], lightcurve: res.lightcurve || [] };
      const n = S.spec.points.length;
      $("specTitle").textContent = n ? `Spectrum at target (live: ${n} measurements)` : "Spectrum at target (measuring…)";
      $("specReset").hidden = true;
      plotSpectrum(); plotLightcurve();
    }
    buildBadges(); buildLinks();
    if (!same) { updateContext(); S.ctxKey = res.key; play(true); }
    return;
  }
  if (res.mode === "moving") {
    S.dets = new Set(DETS);                 // each frame is a single detector image
    if (S.mode === "diff" || S.mode === "cdiff" || S.mode === "track") S.mode = "blink";
    $("tracker").hidden = true;
    document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
    $("targetName").textContent = res.name;
  }
  ["ovGaia", "ovAst"].forEach((id) => ($(id).disabled = res.mode === "moving"));
  normaliseFrames();
  buildTimeline(); buildDetButtons(); rebuildDisplay();
  showProgress(false);
  if (!same || !S.specLabel || S.specLabel.name === "target") {   // keep a spectrum the user clicked during loading
    S.spec = { points: res.points, lightcurve: res.lightcurve };
    S.specLabel = { name: "target", ra: null, dec: null };
    $("specTitle").textContent = "Spectrum at target"; $("specReset").hidden = true;
    plotSpectrum(); plotLightcurve();
  }
  buildBadges(); buildWarnings(); buildLinks();
  if (!isMoving()) { fetchGaia(); fetchArchival(); }
  if (S.ctxKey !== res.key) updateContext();
  S.ctxKey = res.key;
  if (!same) play(true);
}
function buildTimeline() {
  const tl = $("timeline"); tl.innerHTML = "";
  S.epochs.forEach((e, i) => {
    const b = document.createElement("button");
    b.innerHTML = e.archival ? `${e.label} ${e.date_start.slice(0, 4)}` : `${e.date_start}<span class="n">${e.n_images}</span>`;
    b.title = e.archival ? `${e.label} archival image (${e.bands}), observed ${e.date_start}${e.date_end !== e.date_start ? " → " + e.date_end : ""}. Different telescope: compare positions, not brightness.`
      : `${e.date_start} → ${e.date_end}: ${e.n_images} of ${e.n_available} images used (${e.dets.join(" ")})`;
    if (e.archival) b.classList.add("arch");
    b.onclick = () => { play(false); S.cur = i; render(); };
    tl.appendChild(b);
  });
}
function buildDetButtons() {
  const box = $("dets"); box.innerHTML = "";
  const present = new Set(S.result.frames.map((f) => f.det));
  DETS.forEach((d) => {
    const b = document.createElement("button");
    b.innerHTML = `${d}<span class="wl">${DET_WL[d]}µm</span>`;
    b.classList.toggle("on", S.dets.has(d));
    b.disabled = !present.has(d);
    b.title = `Detector ${d} (${DET_WL[d]} µm). Shift-click to select only this one.`;
    b.style.setProperty("--detector-color", DET_COLORS[d]);   // selected button in its detector colour
    b.onclick = (ev) => {
      if (ev.shiftKey) S.dets = new Set([d]);
      else if (S.dets.has(d) && S.dets.size > 1) S.dets.delete(d); else S.dets.add(d);
      buildDetButtons(); setHash(); rebuildDisplay();
    };
    box.appendChild(b);
  });
}
function buildBadges() {
  const r = S.result, b = [];
  if (isMoving()) {
    const days = (S.epochs.at(-1).mjd - S.epochs[0].mjd);
    b.push(`<span class="badge info">${r.stats.n_total} SPHEREx images of this object · showing ${r.stats.n_used} · ${days.toFixed(0)} days</span>`);
    const e = parseFloat(r.orbit?.eccentricity);
    if (e > 1) b.push(`<span class="badge warn">Hyperbolic orbit (e = ${e.toFixed(2)}): interstellar visitor</span>`);
    else if (e >= 0) b.push(`<span class="badge">Orbit e = ${e.toFixed(2)}${r.orbit.semimajor_axis ? `, a = ${(+r.orbit.semimajor_axis).toFixed(2)} au` : ""}</span>`);
    b.push(`<span class="badge">Ephemeris: JPL Horizons via IRSA MOST</span>`);
    $("badges").innerHTML = b.join("");
    return;
  }
  const span = S.sph.length > 1 ? (S.sph.at(-1).mjd - S.sph[0].mjd) / 365.25 : 0;
  b.push(`<span class="badge info">${r.stats.n_used} images · ${S.sph.length} visits · ${span.toFixed(1)} yr</span>`);
  if (r.stats.n_total > r.stats.n_downloaded)
    b.push(`<span class="badge" title="To stay fast, up to 8 images per visit and detector are used">${r.stats.n_total} images in archive${r.stats.n_total > 1000 ? " (deep field)" : ""}</span>`);
  const pm = Math.hypot(S.target.pmra || 0, S.target.pmdec || 0);
  if (pm > 500) b.push(`<span class="badge warn">High proper motion: ${(pm / 1000).toFixed(1)}″/yr → ${(pm / 1000 * span / 6.15).toFixed(1)} px over the data</span>`);
  const latest = S.sph.map((e) => e.date_end).sort().at(-1);
  b.push(`<span class="badge" title="Date of the newest SPHEREx image used for this field. A new position is looked up in the archive on first load and then kept; see the README for refreshing after a data release.">Latest image: ${latest}</span>`);
  b.push(`<span class="badge" id="gaiaBadge">Gaia: checking…</span>`);
  b.push(`<span class="badge info" id="archBadge" hidden title="Archival 2MASS and WISE images from NASA/IPAC IRSA are blinked together with the SPHEREx visits"></span>`);
  b.push(`<span class="badge" id="pmBadge"></span>`);
  $("badges").innerHTML = b.join("");
  showArchBadge();
  showMotionBadge();
}
function showArchBadge() {
  const el = $("archBadge"), ok = Boolean(S.arch && S.arch.epochs.length);
  if (!el) return;
  el.hidden = !ok;
  if (ok) el.textContent = `+ ${S.arch.epochs.map((e) => `${e.label} ${e.date_start.slice(0, 4)}`).join(" + ")}: ${(S.sph.at(-1).jyear - S.arch.epochs[0].jyear).toFixed(0)}-year baseline`;
}
function buildWarnings() {
  const items = [], pts = S.spec.points;
  const sat = pts.filter((p) => p.saturated).length;
  if (pts.length && sat / pts.length > 0.3) {
    const wings = pts.filter((p) => p.method === "wings").length;
    items.push(`<b>Target is saturated</b> in ${sat} of ${pts.length} images (too bright for SPHEREx single exposures). ` +
      (wings ? `Fluxes are measured on the unsaturated PSF wings, so the <b>light curve is reliable in relative terms</b> (compare within one detector); the spectrum shape is only approximate.`
             : `Its motion is still visible, but its spectrum and light curve are not reliable.`));
    $("badges").insertAdjacentHTML("beforeend", `<span class="badge warn">Saturated in SPHEREx</span>`);
  }
  if (S.candOff) items.push("Automatic candidate detection is switched off for this field: the halo of the very bright, saturated target covers the whole image.");
  const blended = pts.filter((p) => p.n_blend > 0);
  if (blended.length) {
    const n = Math.max(...blended.map((p) => p.n_blend));
    items.push(`<b>Deblended:</b> ${n} Gaia star${n > 1 ? "s" : ""} within 35″ ${n > 1 ? "were" : "was"} fitted together with the target (SPHEREx PSF model), so ${n > 1 ? "their" : "its"} light is not counted in the spectrum.`);
  }
  const art = {};
  pts.forEach((p) => p.artifact.forEach((a) => (art[a] = (art[a] || 0) + 1)));
  const arts = Object.entries(art).sort((a, b) => b[1] - a[1]);
  if (arts.length) items.push(`Artifact flags at the target in ${arts.map(([k, n]) => `${n}× ${k}`).join(", ")} measurements – treat those points with care.`);
  const rej = S.result.stats.rejected;
  if (rej.transient) items.push(`${rej.transient} frame(s) skipped: heavy cosmic-ray/transient contamination.`);
  if (rej.failed) items.push(`${rej.failed} cutout(s) could not be downloaded from IRSA (network or archive load).`);
  const bad = pts.filter((p) => !p.good).length;
  if (bad) items.push(`${bad} of ${pts.length} spectral points have masked pixels at the source position (shown hollow).`);
  $("warnCard").hidden = !items.length;
  $("warnings").innerHTML = items.map((x) => `<li>${x}</li>`).join("");
}
function buildLinks() {
  if (isMoving()) {
    const n = encodeURIComponent(S.target.name.replace(/:NID$/, "")), d0 = S.epochs[0].date_start.slice(0, 10).replace(/-/g, "+"),
      d1 = S.epochs.at(-1).date_start.slice(0, 10).replace(/-/g, "+");
    const L = [
      ["Same object in other telescopes (CADC SSOIS)", `https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/ssois/results.html?lang=en&object=${n}&search=bynameall&epoch1=${d0}&epoch2=${d1}&eellipse=&eunits=arcseconds&extres=no&xyres=no`],
      ["JPL Small-Body Database", `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${n}`],
      ["IRSA Moving Object Search Tool", "https://irsa.ipac.caltech.edu/applications/MOST/"],
    ];
    $("links").innerHTML = L.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t} ↗</a>`).join("");
    return;
  }
  const ra = S.result.grid.crval[0], dec = S.result.grid.crval[1], fov = S.fov;
  const L = [
    ["Open in WiseView (13 yr of WISE)", `https://byw.tools/wiseview#ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&size=${Math.round(fov * 60)}&band=3&speed=500&minbright=-50.0000&maxbright=500.0000&window=0.5&diff_window=1&linear=1&color=&zoom=9&border=0&gaia=0&invert=1&maxdyr=0&scandir=0&neowise=0&diff=0&outer_epochs=0&unique_window=1&smooth_scan=0&shift=0&pmra=0&pmdec=0&synth_a=0&synth_b=0`],
    ["SIMBAD", `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${ra.toFixed(5)}%20${dec.toFixed(5)}&Radius=1&Radius.unit=arcmin`],
    ["Other telescopes here (CADC SSOIS)", `https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/cadcbin/ssos/fixedssos.pl?pos=${ra.toFixed(5)},${dec.toFixed(5)}`],
    ["Legacy Survey viewer", `https://www.legacysurvey.org/viewer?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&layer=unwise-neo7&zoom=13`],
    ["IRSA SPHEREx Data Explorer", "https://irsa.ipac.caltech.edu/applications/spherex/"],
  ];
  $("links").innerHTML = L.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t} ↗</a>`).join("");
  const q = S.result.quality;
  if (q && q.max_per_cell < FULL.max_per_cell && S.result.stats.n_total > S.result.stats.n_downloaded) {
    $("links").insertAdjacentHTML("afterbegin", `<button id="sharperBtn" class="small" title="The first look uses up to ${q.max_per_cell} images per visit and detector. Load up to ${FULL.max_per_cell} for less noisy frames and a better spectrum (about 1-2 min).">Sharper images (use more of the ${S.result.stats.n_total} available)</button>`);
    $("sharperBtn").onclick = () => loadTarget(S.target, S.fov, FULL);
  }
}
async function fetchGaia() {
  const r = S.result, rad = (S.fov / 60) * 0.75;
  try {
    S.gaia = await api(`/api/gaia?ra=${r.grid.crval[0]}&dec=${r.grid.crval[1]}&radius_deg=${rad.toFixed(4)}&jyears=${S.sph.map((e) => e.jyear.toFixed(3)).join(",")}`);
  } catch { S.gaia = null; }
  const el = $("gaiaBadge");
  if (!el) return;
  if (!S.gaia || !S.gaia.provider) { el.textContent = "Gaia: unavailable"; return; }
  // Does any Gaia source sit on the target at the first epoch?
  const e0 = S.sph[0], cosd = Math.cos(e0.target_dec * D2R);
  const match = S.gaia.sources.find((s) => {
    const p = s.positions[0];
    return Math.hypot((p[0] - e0.target_ra) * cosd, p[1] - e0.target_dec) * 3600 < 4;
  });
  if (match) {
    el.className = "badge good";
    el.textContent = `Gaia match: G=${fmt(match.g, 1)}${match.pm_total ? `, pm ${fmt(match.pm_total / 1000, 2)}″/yr` : ""}`;
  } else {
    el.className = "badge warn";
    el.textContent = "No Gaia counterpart – invisible in optical light";
  }
  drawOverlay();
}
function archBands(e) {   // the archival bands actually on screen for the selected detectors
  const fr = S.arch.frames.filter((f) => f.epoch === e.epoch);
  const sel = fr.filter((f) => S.dets.has(f.det));
  return (sel.length ? sel : fr).map((f) => (f.band === "K" ? "Ks" : f.band)).join("+");
}
function gaiaPos(s, e) {   // Gaia position at a visit; archival epochs are propagated with the Gaia proper motion
  if (!e.archival) return s.positions[S.sphIdx.get(e.epoch)];
  const p0 = s.positions[0], dt = e.jyear - S.sph[0].jyear;
  if (s.pmra == null || s.pmdec == null) return p0;
  return [p0[0] + (s.pmra * dt) / 3.6e6 / Math.cos(p0[1] * D2R), p0[1] + (s.pmdec * dt) / 3.6e6];
}

// ---------------------------------------------------------------- clicked-object information card
function skySeparationArcsec(ra1, dec1, ra2, dec2) {
  const dra = ((ra2 - ra1 + 540) % 360) - 180;
  return Math.hypot(dra * Math.cos(((dec1 + dec2) / 2) * D2R), dec2 - dec1) * 3600;
}
function objectPickRadius() {
  const pixelArcsec = S.result ? Math.abs(S.result.grid.cdelt[0]) * 3600 : 6.15;
  return Math.min(18, Math.max(8, pixelArcsec * 2));
}
function localObjectAt(ra, dec) {
  const e = S.epochs[S.cur], radius = objectPickRadius(), candidates = [];
  if (!e) return null;
  const add = (obj, objRa, objDec, priority = 2) => {
    if (objRa == null || objDec == null) return;
    const separation_arcsec = skySeparationArcsec(ra, dec, objRa, objDec);
    if (separation_arcsec <= radius) candidates.push({ ...obj, ra: objRa, dec: objDec, separation_arcsec, priority });
  };
  if (S.target?.name && e.target_ra != null) {
    add({ name: S.target.name, type: S.target.kind || (S.target.sso ? "Solar System object" : "Current target"),
      note: S.target.note || null, pm_total: Math.hypot(S.target.pmra || 0, S.target.pmdec || 0) || null,
      source: S.target.source || "Current target", description: S.target.description,
      interesting_fact: S.target.interesting_fact, story: S.target.story, sources: S.target.sources,
      smallBody: Boolean(S.target.sso) }, e.target_ra, e.target_dec, 0);
  }
  for (const s of S.gaia?.sources || []) {
    const p = gaiaPos(s, e);
    if (p) add({ name: `Gaia DR3 ${s.source_id}`, type: "Gaia star", source: S.gaia.provider || "Gaia DR3",
      source_id: s.source_id, g: s.g, parallax: s.parallax, distance_pc: s.parallax > 0 ? 1000 / s.parallax : null,
      pm_total: s.pm_total, bp_rp: s.bp_rp, teff: s.teff }, p[0], p[1]);
  }
  const sphIndex = S.sphIdx?.get(e.epoch);
  for (const o of sphIndex != null ? (S.ast?.[sphIndex]?.objects || []) : []) {
    add({ name: o.name || "Known small body", type: "Solar System object", source: "JPL Small-Body Identification", vmag: o.vmag, smallBody: true }, o.ra, o.dec, 1);
  }
  candidates.sort((a, b) => Math.abs(a.separation_arcsec - b.separation_arcsec) < 1 ? a.priority - b.priority : a.separation_arcsec - b.separation_arcsec);
  return candidates[0] || null;
}
function closeObjectCard() {
  S.objectRequest += 1;
  const card = $("objectCard");
  if (!card) return;
  clearTimeout(S.objectCloseTimer); card.classList.remove("open");
  S.objectCloseTimer = setTimeout(() => { card.hidden = true; }, 230);
  S.selectedObject = null;
}
function setObjectCardCompact(compact) {   // compact strip under the image; "Details" shows the full text
  $("objectCard").classList.toggle("compact", compact);
  $("objectCardMore").textContent = compact ? "Details ▾" : "Less ▴";
  $("objectCardMore").setAttribute("aria-expanded", String(!compact));
}
function openObjectCard() {
  const card = $("objectCard");
  setObjectCardCompact(true);
  clearTimeout(S.objectCloseTimer); card.hidden = false;
  requestAnimationFrame(() => card.classList.add("open"));
}
function addObjectDetail(label, value) {
  if (value == null || value === "") return;
  const dt = document.createElement("dt"), dd = document.createElement("dd");
  dt.textContent = label; dd.textContent = value; $("objectCardDetails").append(dt, dd);
}
function addObjectLink(label, href) {
  const a = document.createElement("a");
  a.textContent = `${label} ↗`; a.href = href; a.target = "_blank"; a.rel = "noopener";
  $("objectCardLinks").appendChild(a);
}
function addObjectMeta(text) {
  const chip = document.createElement("span"); chip.textContent = text; $("objectCardSpherexMeta").appendChild(chip);
}
function fallbackDescription(obj) {
  const type = (obj.type || "").toLowerCase();
  if (type.includes("brown dwarf")) return "A brown dwarf forms like a star but is not massive enough to sustain ordinary hydrogen fusion. Its cool atmosphere emits much of its detectable light at infrared wavelengths.";
  if (type.includes("galaxy")) return "A galaxy is a gravitationally bound system of stars, gas, dust and dark matter. Infrared observations can reveal older stars and dust-obscured star formation.";
  if (type.includes("planet")) return "This is a catalogued planetary object or candidate associated with the selected sky position. Most exoplanets are not spatially resolved from their host stars in SPHEREx images.";
  if (type.includes("asteroid") || type.includes("comet") || type.includes("solar system")) return "This is a moving Solar System object. Repeated observations are needed because its sky position changes with time relative to the background stars.";
  if (type.includes("variable")) return "This is a star whose measured brightness changes with time. Repeated infrared visits help distinguish intrinsic variability from motion and image artifacts.";
  if (type.includes("star")) return "This is a catalogued star at the selected position. Its colour, spectrum, parallax and proper motion can reveal its temperature, distance and motion when those measurements are available.";
  return "A catalogued celestial object is associated with this position. The panel only displays properties returned by the connected catalogues or measured in the currently loaded SPHEREx field.";
}
function renderSpherexConnection(obj) {
  const text = $("objectCardSpherex"); $("objectCardSpherexMeta").replaceChildren();
  let inside = false;
  try {
    const [x, y] = world2pix(obj.ra, obj.dec), [ny, nx] = S.result.grid.shape;
    inside = x >= 0 && x < nx && y >= 0 && y < ny;
  } catch { /* invalid WCS position */ }
  if (!inside) { text.textContent = "This object is not inside the currently loaded SPHEREx field."; return; }
  const dets = [...new Set(S.result.frames.map((f) => f.det))].sort();
  text.textContent = `This position falls inside the loaded SPHEREx field, which contains ${S.result.stats.n_used} usable images across ${S.sph.length} visit${S.sph.length === 1 ? "" : "s"}.`;
  addObjectMeta(`${S.result.stats.n_used} images`); addObjectMeta(`${S.sph.length} visits`);
  if (dets.length) addObjectMeta(dets.join(" · "));
}
function showObjectCard(obj) {
  if (!obj || obj.matched === false) { closeObjectCard(); return; }
  openObjectCard(); S.selectedObject = obj;
  $("objectCardDetails").replaceChildren(); $("objectCardLinks").replaceChildren(); $("objectCardSpherexMeta").replaceChildren();
  $("objectCardStatus").textContent = obj.source ? `Catalogue match · ${obj.source}` : "Catalogue match";
  $("objectCardName").textContent = obj.name || "Catalogued object";
  $("objectCardType").textContent = obj.type || "Catalogued object";
  $("objectCardDescription").textContent = obj.description || fallbackDescription(obj);
  $("objectCardFactBox").hidden = !obj.interesting_fact; $("objectCardStoryBox").hidden = !obj.story;
  $("objectCardFact").textContent = obj.interesting_fact || ""; $("objectCardStory").textContent = obj.story || "";
  $("objectCardNote").textContent = obj.note || "";
  addObjectDetail("Coordinates", `${sexa(obj.ra, true)} ${sexa(obj.dec)}`);
  addObjectDetail("Click offset", obj.separation_arcsec == null ? null : `${fmt(obj.separation_arcsec, 1)}″`);
  addObjectDetail("G magnitude", obj.g == null ? null : fmt(obj.g, 2)); addObjectDetail("V magnitude", obj.vmag == null ? null : fmt(obj.vmag, 2));
  addObjectDetail("Spectral type", obj.spectral_type); addObjectDetail("Temperature", obj.teff == null ? null : `${fmt(obj.teff, 0)} K`);
  addObjectDetail("BP−RP colour", obj.bp_rp == null ? null : fmt(obj.bp_rp, 2)); addObjectDetail("Parallax", obj.parallax == null ? null : `${fmt(obj.parallax, 2)} mas`);
  addObjectDetail("Approx. distance", obj.distance_pc == null ? null : `${fmt(obj.distance_pc, obj.distance_pc < 100 ? 1 : 0)} pc`);
  addObjectDetail("Proper motion", obj.pm_total == null ? null : `${fmt(obj.pm_total / 1000, 3)}″/yr`);
  addObjectDetail("Earth distance", obj.geo_au == null ? null : `${fmt(obj.geo_au, 3)} au`); addObjectDetail("Sun distance", obj.sun_au == null ? null : `${fmt(obj.sun_au, 3)} au`);
  renderSpherexConnection(obj);
  const nearby = `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${encodeURIComponent(`${obj.ra} ${obj.dec}`)}&Radius=12&Radius.unit=arcsec`;
  addObjectLink(obj.source === "SIMBAD" ? "SIMBAD" : "SIMBAD nearby", obj.source === "SIMBAD" ? `https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(obj.simbad_id || obj.name)}` : nearby);
  if (obj.source_id) addObjectLink("Gaia archive", "https://gea.esac.esa.int/archive/");
  if (obj.smallBody) addObjectLink("JPL database", `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(obj.name)}`);
  for (const source of obj.sources || []) if (source?.label && source?.url) addObjectLink(source.label, source.url);
  addObjectLink("SPHEREx instrument", "https://spherex.caltech.edu/page/instrument");
}
async function resolveObjectAt(ra, dec, radiusArcsec = objectPickRadius()) {
  const local = localObjectAt(ra, dec), request = ++S.objectRequest;
  if (local) { showObjectCard(local); return; }
  try {
    const obj = await api(`/api/object-info?ra=${ra}&dec=${dec}&radius_arcsec=${radiusArcsec.toFixed(2)}`);
    if (request === S.objectRequest && obj.matched) showObjectCard(obj);
    else if (request === S.objectRequest) closeObjectCard();
  } catch { if (request === S.objectRequest) closeObjectCard(); }
}
function showMovingObjectCard() {
  const e = S.epochs[S.cur];
  showObjectCard({ name: S.result.name || S.target.name, type: S.target.kind || "Solar System object", source: "JPL Horizons via IRSA MOST",
    ra: e.target_ra, dec: e.target_dec, vmag: e.vmag, geo_au: e.geo_au, sun_au: e.sun_au, smallBody: true,
    description: S.target.description, interesting_fact: S.target.interesting_fact, story: S.target.story, sources: S.target.sources,
    note: `Object-centred frame observed ${e.date_start}.` });
}
async function fetchArchival() {
  const key = S.key;
  let r = null;
  try { r = await api(`/api/archival/${key}`); } catch { return; }
  if (S.key !== key || !r || !r.epochs.length) return;
  r.epochs.sort((a, b) => a.mjd - b.mjd);
  r.epochs.forEach((e) => { [e.target_ra, e.target_dec] = propagateJs(S.target, e.jyear); });
  S.arch = r;
  normaliseFrames(); rebuildDisplay(); showArchBadge(); showMotionBadge();
}
async function fetchAsteroids() {
  const r = S.result;
  $("ovAst").disabled = true;
  try {
    S.ast = await api(`/api/asteroids?ra=${r.grid.crval[0]}&dec=${r.grid.crval[1]}&half_width_deg=${(S.fov / 120).toFixed(4)}&mjds=${S.sph.map((e) => e.mjd.toFixed(4)).join(",")}`);
  } catch { S.ast = null; }
  $("ovAst").disabled = false;
  drawOverlay();
}

// ---------------------------------------------------------------- saved candidates (kept in this browser)
const SAVED_KEY = "sxtm.candidates";
function loadSaved() { try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch { return []; } }
function storeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* storage blocked: the list is lost on reload */ }
  renderSaved(); drawOverlay();
}
function gaiaNear(ra, dec) {   // is a Gaia star within 4″ in the frame on screen? null = Gaia not loaded
  if (!S.gaia || !S.gaia.provider) return null;
  const e = S.epochs[S.cur], cosd = Math.cos(dec * D2R);
  return S.gaia.sources.some((s) => { const p = gaiaPos(s, e); return p && Math.hypot((p[0] - ra) * cosd, p[1] - dec) * 3600 < 4; });
}
/* Save the clicked position (or, with nothing clicked, the target) in the frame on screen. */
function addSaved() {
  if (!S.result || isMoving()) return;
  const e = S.epochs[S.cur], clicked = S.specLabel && S.specLabel.ra != null;
  const ra = clicked ? S.specLabel.ra : e.target_ra, dec = clicked ? S.specLabel.dec : e.target_dec;
  const g = gaiaNear(ra, dec);
  // field name and FOV of the result on screen (S.target already changes while a new field loads)
  const h = new URLSearchParams({ ra: ra.toFixed(6), dec: dec.toFixed(6), fov: S.result.fov_arcmin, mode: S.mode, dets: [...S.dets].join(","), name: "Candidate" });
  storeSaved([...loadSaved(), { ra, dec, field: S.result.name || "", date: e.archival ? `${e.label} ${e.date_start}` : e.date_start,
    mode: S.mode, dets: [...S.dets].join("+"), gaia: g == null ? "unknown" : g ? "yes" : "no",
    link: `${location.origin}${location.pathname}#${h}`, saved: new Date().toISOString() }]);
}
function renderSaved() {
  const list = loadSaved();
  $("savedCount").textContent = list.length ? `(${list.length})` : "";
  $("savedCsv").disabled = !list.length;
  $("savedList").innerHTML = list.length
    ? list.map((c, i) => `<li><a href="${esc(c.link)}" title="Open a view centred on this position">${sexa(c.ra, true)} ${sexa(c.dec)}</a>
        <button class="ghost small" data-i="${i}" title="Remove">✕</button><br>
        <span class="muted">${esc(c.field || "field")} · ${esc(c.date)} · ${esc(c.dets)} · Gaia star: ${esc(c.gaia)}</span></li>`).join("")
    : `<li class="muted">Nothing saved yet. Click a source on the image, then “Save as candidate”.</li>`;
  $("savedList").querySelectorAll("button").forEach((b) => (b.onclick = () => { const l = loadSaved(); l.splice(+b.dataset.i, 1); storeSaved(l); }));
}
function downloadSaved() {
  const cols = ["ra_deg", "dec_deg", "ra_hms", "dec_dms", "field", "visit_date", "mode", "detectors", "gaia_star_within_4arcsec", "link", "saved_utc"];
  const rows = loadSaved().map((c) => [c.ra.toFixed(6), c.dec.toFixed(6), sexa(c.ra, true), sexa(c.dec).replace("−", "-"),
    c.field, c.date, c.mode, c.dets, c.gaia, c.link, c.saved]);
  const csv = [cols, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "spherex-candidates.csv"; a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- sharing and embedding
function viewUrl(embed) {
  const h = new URLSearchParams(location.hash.slice(1));
  if (embed) h.set("embed", "1"); else h.delete("embed");
  return `${location.origin}${location.pathname}#${h}`;
}
function share(text, btn) {   // show the text ready to copy, and copy it when the browser allows
  const box = $("shareBox"), label = btn.textContent;
  box.hidden = false; box.value = text; box.select();
  navigator.clipboard?.writeText(text).then(() => { btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = label), 1500); }).catch(() => {});
}

// ---------------------------------------------------------------- parallax tracker
/* The normal frames are a median of all images of a visit, which also removes anything that moves
   during the visit (10-40 days). A body far beyond Neptune drifts mostly because the Earth moves
   (~17 px in a 15-day visit at 100 AU, ~3 px at 500 AU). Here the single images of a visit are shifted along the path of a body at a
   trial distance d (a fixed point in space seen from the Earth's position at each image) plus a
   constant on-sky rate for its own orbit, then median-stacked: such a body adds up, stars smear.
   Checked against JPL Horizons for Eris, Makemake, Sedna and Neptune: < 0.4 px over 40 days. */
const TRK = { key: null, visits: new Map(), loading: new Set(), failed: new Set() };
const fmtAU = (d) => `${d < 100 ? d.toFixed(0) : Math.round(d / 10) * 10} AU`;
function trkParams() { return { d: 10 ** +$("trkDist").value, ve: +$("trkVe").value || 0, vn: +$("trkVn").value || 0 }; }
function trkVisit(ep) {   // normalised single images of one SPHEREx visit (fetched on demand), or null
  if (!S.result || isMoving() || ep < 0) return null;
  if (TRK.key !== S.key) { TRK.key = S.key; TRK.visits.clear(); TRK.loading.clear(); TRK.failed.clear(); }
  if (TRK.visits.has(ep)) return TRK.visits.get(ep);
  // the server keeps a field only when it has finished loading: ask after that, and not again after a failure
  if (S.result.partial || TRK.failed.has(ep)) return null;
  if (!TRK.loading.has(ep)) {
    const key = S.key;
    TRK.loading.add(ep);
    api(`/api/track/${key}/${ep}`).then((r) => {
      if (TRK.key !== key) return;
      TRK.visits.set(ep, r.images.map((im) => {   // same normalisation as normaliseFrames
        const a = decodeF32(im.data), fin = Array.from(a).filter(Number.isFinite).sort((p, q) => p - q);
        const med = percentile(fin, 50), mad = percentile(fin.map((v) => Math.abs(v - med)).sort((p, q) => p - q), 50) * 1.4826 || 1;
        for (let i = 0; i < a.length; i++) a[i] = (a[i] - med) / mad;
        return { mjd: im.mjd, det: im.det, earth: im.earth, z: a };
      }));
    }).catch(() => { if (TRK.key === key) TRK.failed.add(ep); })   // pressing Track again retries
      .finally(() => { TRK.loading.delete(ep); if (TRK.key === key) trkRedraw(); });
  }
  return null;
}
function trkShifts(ims, p) {   // [dx, dy] px of the body in each image, relative to the visit's middle image
  const [ra0, dec0] = S.result.grid.crval, pix = Math.abs(S.result.grid.cdelt[0]) * 3600;
  const u0 = [Math.cos(dec0 * D2R) * Math.cos(ra0 * D2R), Math.cos(dec0 * D2R) * Math.sin(ra0 * D2R), Math.sin(dec0 * D2R)];
  const ref = ims[ims.length >> 1], P = ref.earth.map((e, k) => e + p.d * u0[k]);   // the body, fixed in space
  const [cx, cy] = world2pix(ra0, dec0);
  return ims.map((im) => {
    const v = P.map((x, k) => x - im.earth[k]), n = Math.hypot(...v);
    const [x, y] = world2pix((Math.atan2(v[1], v[0]) / D2R + 360) % 360, Math.asin(v[2] / n) / D2R), dt = im.mjd - ref.mjd;
    return [x - cx - (p.ve * dt) / pix, y - cy + (p.vn * dt) / pix];   // grid x grows westward
  });
}
function bilinear(a, nx, ny, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  if (x0 < 0 || y0 < 0 || x0 >= nx - 1 || y0 >= ny - 1) return NaN;
  const i = y0 * nx + x0;
  return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + nx] * (1 - fx) + a[i + nx + 1] * fx) * fy;
}
function trackFrame(ep) {   // shift-and-median of one visit for the current trial distance and rate
  const ims = trkVisit(ep);
  if (!ims || !ims.length) return null;
  const [ny, nx] = S.result.grid.shape, sh = trkShifts(ims, trkParams());
  const dets = ims.some((im) => S.dets.has(im.det)) ? [...S.dets] : DETS;
  const out = new Float32Array(nx * ny), cnt = new Uint8Array(nx * ny), tmp = [];
  for (const det of dets) {
    const sel = ims.map((im, k) => [im.z, sh[k]]).filter((_, k) => ims[k].det === det);
    if (!sel.length) continue;
    const need = Math.min(3, sel.length);   // one image alone could be a cosmic ray
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      tmp.length = 0;
      for (const [z, [sx, sy]] of sel) { const v = bilinear(z, nx, ny, x + sx, y + sy); if (Number.isFinite(v)) tmp.push(v); }
      if (tmp.length < need) continue;
      tmp.sort((a, b) => a - b);
      const h = tmp.length >> 1, i = y * nx + x;
      out[i] += tmp.length & 1 ? tmp[h] : (tmp[h - 1] + tmp[h]) / 2; cnt[i]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? out[i] / Math.sqrt(cnt[i]) : NaN;   // as in composite()
  return out;
}
function trackDisplay() {   // until a visit's single images are there, show its normal frame
  return S.epochs.map((e) => [e.archival ? null : trackFrame(e.epoch) || composite(e.epoch, [...S.dets])]);
}
function trackLabel(ep) {
  const ims = TRK.key === S.key ? TRK.visits.get(ep) : null;
  if (S.result.partial) return "normal frame: Track starts when the field has finished loading";
  if (TRK.key === S.key && TRK.failed.has(ep)) return "normal frame: the single images could not be loaded (press Track to retry)";
  if (!ims) return "normal frame while the single images load…";
  if (!ims.length) return "no single images for this visit";
  const n = ims.filter((im) => S.dets.has(im.det)).length || ims.length;
  return `${n} single image${n === 1 ? "" : "s"} shifted for a body at ${fmtAU(trkParams().d)}`;
}
function trkNote() {
  const p = trkParams();
  $("trkDistVal").textContent = fmtAU(p.d);
  const e = S.epochs[S.cur], ims = e && TRK.key === S.key ? TRK.visits.get(e.epoch) : null;
  if (S.mode !== "track" || !ims || !ims.length) { $("trkNote").textContent = ""; return; }
  const sh = trkShifts(ims, p), xs = sh.map((s) => s[0]), ys = sh.map((s) => s[1]);
  const drift = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  $("trkNote").textContent = `A body at ${fmtAU(p.d)} moves ${drift.toFixed(0)} px (${(drift * 6.15 / 60).toFixed(1)}′) during this visit; ` +
    `where it leaves the field, those images are left out. Stars smear, the body adds up at the right distance.`;
}
function trkRedraw() {
  trkNote();
  if (S.mode !== "track" || !S.result) return;
  S.display = trackDisplay(); computeLimits(); render(); setHash();
}

// ---------------------------------------------------------------- measured proper motion
/* Centroid the target in every visit (near its predicted position) and fit a straight line in
   time. SPHEREx astrometry is good to <0.3", so even ~1-pixel motions over a year are measurable. */
// Systematic centroid error per visit (co-adds of a few reprojected images, PSF changes across the
// detector, extended sources): 0.12 px = 0.74". Keeps galaxy nuclei (e.g. Centaurus A) from "moving".
const CENTROID_FLOOR_PX = 0.12;
function measureMotion() {
  if (!S.result || isMoving() || S.epochs.length < 3 || S.result.partial === "preview") return null;
  const [ny, nx] = S.result.grid.shape, pix = Math.abs(S.result.grid.cdelt[0]) * 3600;
  const dets = S.dets.size ? [...S.dets] : DETS;
  const pts = [];
  // Saturated stars have flat/masked cores: centroid the symmetric PSF wings in a wider box.
  const satFrac = S.result.points.length ? S.result.points.filter((p) => p.saturated).length / S.result.points.length : 0;
  const hb = satFrac > 0.3 ? 4 : 2;
  for (const e of S.epochs) {
    if (e.archival && !dets.some((d) => S.z.has(`${e.epoch}|${d}`))) continue;   // same wavelength range only
    const img = composite(e.epoch, dets);
    if (!img) continue;
    const [px, py] = world2pix(e.target_ra, e.target_dec);
    let best = -Infinity, bx = 0, by = 0;
    const sr = e.archival ? 1 : 3;   // archival frames: stay on the prediction, a brighter neighbour may be close
    for (let y = Math.round(py) - sr; y <= Math.round(py) + sr; y++)
      for (let x = Math.round(px) - sr; x <= Math.round(px) + sr; x++) {
        if (x < 2 || y < 2 || x >= nx - 2 || y >= ny - 2) continue;
        const v = img[y * nx + x];
        if (Number.isFinite(v) && v > best) { best = v; bx = x; by = y; }
      }
    if (!(best > 5)) continue;           // need a clear (>5-sigma) source: noise peaks in empty sky reach 3-4 sigma
    if (hb > 2) { bx = Math.round(px); by = Math.round(py); }   // wide box centred on the prediction
    let sw = 0, sx = 0, sy = 0;
    for (let y = by - hb; y <= by + hb; y++)
      for (let x = bx - hb; x <= bx + hb; x++) {
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const v = img[y * nx + x];
        if (Number.isFinite(v) && v > 0) { sw += v; sx += v * x; sy += v * y; }
      }
    if (sw > 0) pts.push({ t: e.jyear, x: sx / sw, y: sy / sw, arch: Boolean(e.archival) });
  }
  if (pts.length < 3) return null;
  const fit = (key) => {
    const n = pts.length, mt = pts.reduce((a, p) => a + p.t, 0) / n, mv = pts.reduce((a, p) => a + p[key], 0) / n;
    let sxx = 0, sxy = 0;
    pts.forEach((p) => { sxx += (p.t - mt) ** 2; sxy += (p.t - mt) * (p[key] - mv); });
    const b = sxy / sxx, res = pts.reduce((a, p) => a + (p[key] - mv - b * (p.t - mt)) ** 2, 0);
    return { slope: b, err: Math.sqrt(res / Math.max(1, n - 2) / sxx) };
  };
  const fx = fit("x"), fy = fit("y");
  // grid x grows westward (cdelt1 < 0): +x = -RA direction
  const pmra = -fx.slope * pix, pmdec = fy.slope * pix;
  const err = Math.hypot(fx.err, fy.err) * pix / Math.SQRT2;
  return { pmra, pmdec, total: Math.hypot(pmra, pmdec), err: Math.max(err, (CENTROID_FLOOR_PX * pix) / Math.max(0.1, pts.at(-1).t - pts[0].t)),
           n: pts.length, span: pts.at(-1).t - pts[0].t, arch: pts.filter((p) => p.arch).length };
}
function showMotionBadge() {
  const m = measureMotion(), el = $("pmBadge");
  if (!el) return;
  el.hidden = !m;
  if (!m) return;
  const cat = Math.hypot(S.target.pmra || 0, S.target.pmdec || 0) / 1000;
  const sig = m.total / m.err, SIG = 5;   // 5 sigma: a 7x7 search box gives noise centroids that fake 3-4 sigma motions
  const who = m.arch ? "Measured (SPHEREx + archival)" : "Measured by SPHEREx";
  el.className = "badge " + (sig > SIG ? "good" : "");
  el.title = `Centroid fit over ${m.n} visits spanning ${m.span.toFixed(2)} yr${m.arch ? ` (incl. ${m.arch} archival 2MASS/WISE)` : ""}: μα* = ${m.pmra.toFixed(2)}″/yr, μδ = ${m.pmdec.toFixed(2)}″/yr`;
  el.textContent = sig > SIG
    ? `${who}: ${m.total.toFixed(m.err < 0.1 ? 2 : 1)} ± ${m.err.toFixed(m.err < 0.1 ? 2 : 1)}″/yr${cat > 0.05 ? ` (catalogue ${cat.toFixed(1)}″/yr)` : " – moving!"}`
    : `${who}: no significant motion (< ${(SIG * m.err).toFixed(1)}″/yr)`;
}

// ---------------------------------------------------------------- Aladin sky context
let aladin = null, aladinReady = null;
function ensureAladin() {
  if (aladinReady) return aladinReady;
  aladinReady = new Promise((resolve) => {
    const start = () => {
      if (!window.A) return setTimeout(start, 300);
      A.init.then(() => {
        aladin = A.aladin("#aladin", { survey: $("survey").value, fov: 0.2, projection: "TAN",
          showReticle: false, showLayersControl: false, showGotoControl: false, showFrame: false,
          showFullscreenControl: true, showCooGridControl: false, showSimbadPointerControl: false });
        // Click (not drag) on the map = pick a position that can be loaded in the SPHEREx viewer.
        aladin.on("click", (e) => {
          if (!e || e.isDragging || !Number.isFinite(e.ra) || !Number.isFinite(e.dec)) return;
          pickPosition(e.ra, e.dec);
        });
        resolve(aladin);
      }).catch(() => resolve(null));
    };
    start();
  });
  return aladinReady;
}
function pickPosition(ra, dec) {
  S.pick = { ra, dec };
  $("pick").hidden = false;
  $("pickText").textContent = `Selected: ${sexa(ra, true)} ${sexa(dec)}`;
  $("pickSimbad").href = `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${ra.toFixed(5)}%20${dec.toFixed(5)}&Radius=1&Radius.unit=arcmin`;
  try {
    if (!S.pickCat) {
      S.pickCat = A.catalog({ name: "Selected position", sourceSize: 18, shape: "cross", color: "#39d98a" });
      aladin.addCatalog(S.pickCat);
    } else S.pickCat.removeAll?.();
    S.pickCat.addSources([A.source(ra, dec, { label: "selected" })]);
  } catch { /* marker is optional */ }
  resolveObjectAt(ra, dec, 20);
}
function propagateJs(t, jyear) {
  const dt = jyear - (t.ref_epoch || 2000);
  const dec = t.dec + ((t.pmdec || 0) * dt) / 3.6e6;
  return [t.ra + ((t.pmra || 0) * dt) / 3.6e6 / Math.cos(t.dec * D2R), dec];
}
// First visit: the sky map is shown at once (Orion, a rich and recognisable field), ready to pick a position.
async function showSkyStart() {
  $("contextCard").hidden = false;
  const al = await ensureAladin();
  if (!al || S.target) return;
  al.gotoRaDec(83.82, -5.39);
  const box = $("aladin"), aspect = Math.max(1, box.clientWidth / Math.max(1, box.clientHeight));
  al.setFoV(1.6 * aspect);
}
async function updateContext() {
  $("contextCard").hidden = false;
  const al = await ensureAladin();
  if (!al || !S.result) return;
  const [ny, nx] = S.result.grid.shape, c = S.result.grid.crval;
  al.removeLayers?.();
  S.pickCat = null; S.pick = null; $("pick").hidden = true;
  if (isMoving()) {
    const pts = S.epochs.map((e) => [e.target_ra, e.target_dec]);
    const ras = pts.map((p) => p[0]), decs = pts.map((p) => p[1]);
    const mid = pts[Math.floor(pts.length / 2)];
    const span = Math.max(Math.max(...decs) - Math.min(...decs), (Math.max(...ras) - Math.min(...ras)) * Math.cos(mid[1] * D2R));
    al.gotoRaDec(mid[0], mid[1]); al.setFoV(Math.min(180, Math.max(0.5, span * 1.3)));
    const tr = A.graphicOverlay({ color: "#c58cff", lineWidth: 2, name: "Object path" });
    al.addOverlay(tr); tr.add(A.polyline(pts));
    const marks = A.catalog({ name: "Frames", sourceSize: 8, color: "#c58cff", displayLabel: true, labelColumn: "label", labelColor: "#e2c8ff" });
    al.addCatalog(marks);
    marks.addSources(S.epochs.map((e, i) => A.source(e.target_ra, e.target_dec,
      { label: i === 0 || i === S.epochs.length - 1 || S.epochs[i].date_start.slice(0, 7) !== S.epochs[i - 1].date_start.slice(0, 7) ? e.date_start.slice(0, 10) : "" })));
    $("contextNote").textContent = `Purple: path of ${S.result.name} across the sky at the times SPHEREx imaged it (${S.epochs[0].date_start.slice(0, 10)} → ${S.epochs.at(-1).date_start.slice(0, 10)}). Powered by Aladin Lite (CDS).`;
    return;
  }
  al.gotoRaDec(c[0], c[1]);
  // setFoV is the horizontal field: widen it on wide panels so the whole SPHEREx square stays visible
  const box = $("aladin"), aspect = Math.max(1, box.clientWidth / Math.max(1, box.clientHeight));
  al.setFoV((S.fov / 60) * 1.5 * aspect);
  const fp = A.graphicOverlay({ color: "#4fb3ff", lineWidth: 2, name: "SPHEREx field" });
  al.addOverlay(fp);
  const corners = [[-0.5, -0.5], [nx - 0.5, -0.5], [nx - 0.5, ny - 0.5], [-0.5, ny - 0.5]].map(([x, y]) => pix2world(x, y));
  fp.add(A.polygon(corners));
  const t = S.target, pm = Math.hypot(t.pmra || 0, t.pmdec || 0);
  if (pm > 100) {
    const track = A.graphicOverlay({ color: "#ffb547", lineWidth: 2, name: "Proper-motion track" });
    al.addOverlay(track);
    const pts = [];
    for (let y = 1950; y <= 2030; y += 2) pts.push(propagateJs(t, y));
    track.add(A.polyline(pts));
    const marks = A.catalog({ name: "Epochs", sourceSize: 12, shape: "circle", color: "#ffb547",
      displayLabel: true, labelColumn: "label", labelColor: "#ffd28a", labelFont: "12px sans-serif" });
    al.addCatalog(marks);
    const e0 = S.sph[0], e1 = S.sph.at(-1);
    const stops = [[1953, "1953 POSS-I"], [1993, "1993 DSS2"], [2016, "2016 Gaia"],
                   [e1.jyear, `${e0.date_start.slice(0, 4)}–${e1.date_start.slice(0, 4)} SPHEREx`]];
    marks.addSources(stops.map(([y, label]) => { const [ra, dec] = propagateJs(t, y); return A.source(ra, dec, { label }); }));
    const moved = (pm / 1000) * (e1.jyear - 1953) / 60;
    $("contextNote").textContent = `Orange track: ${t.name || "target"} moved ${moved.toFixed(1)}′ since the 1953 Palomar plates (${(pm / 1000).toFixed(2)}″/yr). Switch the background to compare decades. Blue square: the SPHEREx field above. Powered by Aladin Lite (CDS).`;
    if (moved * 60 > S.fov * 60 * 0.6) al.setFoV(Math.max((S.fov / 60) * 1.5, (moved / 60) * 1.4) * aspect);
  } else {
    $("contextNote").textContent = "Blue square: the SPHEREx field shown above. Use the background menu to compare with other surveys. Powered by Aladin Lite (CDS).";
  }
}

// ---------------------------------------------------------------- charts
const PLOT_LAYOUT = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: "#cfd8e8", size: 11 },
  margin: { l: 50, r: 12, t: 26, b: 40 }, showlegend: true, autosize: true, legend: { orientation: "h", y: -0.25, font: { size: 10 } },
  xaxis: { gridcolor: "#24304a", zerolinecolor: "#24304a" }, yaxis: { gridcolor: "#24304a", zerolinecolor: "#24304a" },
};
const EPOCH_COLORS = ["#4fb3ff", "#ffb547", "#39d98a", "#ff6b6b", "#c58cff", "#5ef0e0", "#f0e05e", "#ff8fc7"];
function plotSpectrum() {
  if (!window.Plotly || !S.spec) return;
  const vis = new Set(S.epochs.map((e) => e.epoch));
  const pts = S.spec.points.filter((p) => p.wavelength_um && vis.has(p.epoch));
  const traces = [];
  if (S.epochs.length > 8) {   // many visits (e.g. moving objects): one trace, colour = date
    const g = pts.filter((p) => p.good);
    traces.push({ x: g.map((p) => p.wavelength_um), y: g.map((p) => p.flux_mjy), mode: "markers", type: "scatter", name: "measurements",
      text: g.map((p) => mjdToDate(p.mjd)),
      marker: { size: 6, color: g.map((p) => p.mjd), colorscale: "Viridis", showscale: false },
      error_y: { type: "data", array: g.map((p) => p.err_mjy || 0), visible: true, thickness: 1, width: 0, color: "rgba(200,210,230,.35)" },
      hovertemplate: "%{x:.3f} µm<br>%{y:.3f} mJy<br>%{text}<extra></extra>" });
  }
  S.epochs.forEach((e, k) => {
    if (S.epochs.length > 8) return;
    const g = pts.filter((p) => p.epoch === e.epoch && p.good);
    if (!g.length) return;
    traces.push({ x: g.map((p) => p.wavelength_um), y: g.map((p) => p.flux_mjy), mode: "markers", type: "scatter",
      name: e.date_start, marker: { size: 6, color: EPOCH_COLORS[k % EPOCH_COLORS.length] },
      error_y: { type: "data", array: g.map((p) => p.err_mjy || 0), visible: true, thickness: 1, width: 0, color: "rgba(200,210,230,.35)" },
      hovertemplate: "%{x:.3f} µm<br>%{y:.3f} mJy<br>" + e.date_start + "<extra></extra>" });
  });
  const bad = pts.filter((p) => !p.good);
  if (bad.length) traces.push({ x: bad.map((p) => p.wavelength_um), y: bad.map((p) => p.flux_mjy), mode: "markers", type: "scatter",
    name: "flagged", marker: { size: 6, color: "rgba(0,0,0,0)", line: { color: "#8e9bb3", width: 1 } }, hoverinfo: "skip" });
  const shapes = FEATURES.map((f) => ({ type: "rect", xref: "x", yref: "paper", x0: f.lo, x1: f.hi, y0: 0, y1: 1,
    fillcolor: "rgba(79,179,255,.07)", line: { width: 0 } }));
  const ann = FEATURES.map((f) => ({ x: (f.lo + f.hi) / 2, y: 1, xref: "x", yref: "paper", text: f.label, showarrow: false,
    font: { size: 9, color: "#7f9cc8" }, yanchor: "bottom" }));
  LINES.forEach(([w, t]) => { shapes.push({ type: "line", xref: "x", yref: "paper", x0: w, x1: w, y0: 0, y1: 0.92, line: { color: "rgba(255,181,71,.35)", dash: "dot", width: 1 } });
    ann.push({ x: w, y: 0.92, xref: "x", yref: "paper", text: t, showarrow: false, font: { size: 8, color: "#c9a35e" }, yanchor: "bottom" }); });
  // y range: every good measurement is visible; flagged points far outside are counted, not plotted off-scale
  const goodPts = pts.filter((p) => p.good);
  const ys = (goodPts.length ? goodPts : pts).map((p) => p.flux_mjy).filter(Number.isFinite).sort((a, b) => a - b);
  const y0 = ys.length ? ys[0] : 0, y1 = ys.length ? ys.at(-1) : 1, pad = Math.max(0.08 * (y1 - y0), 0.05 * Math.abs(y1) || 0.05);
  const out = bad.filter((p) => p.flux_mjy < y0 - pad || p.flux_mjy > y1 + pad * 1.6).length;
  if (out) ann.push({ xref: "paper", yref: "paper", x: 1, y: -0.32, xanchor: "right", yanchor: "top", showarrow: false,
    text: `${out} flagged point${out > 1 ? "s" : ""} outside the plot`, font: { size: 9, color: "#8e9bb3" } });
  Plotly.react("specPlot", traces, { ...PLOT_LAYOUT, shapes, annotations: ann,
    xaxis: { ...PLOT_LAYOUT.xaxis, title: "Wavelength (µm)", range: [0.7, 5.05] },
    yaxis: { ...PLOT_LAYOUT.yaxis, title: "Flux density (mJy)", range: ys.length ? [y0 - pad, y1 + pad * 1.6] : undefined } },
    { displayModeBar: false, responsive: true });
}
function plotLightcurve() {
  if (!window.Plotly || !S.spec) return;
  const vis = new Set(S.epochs.map((e) => e.epoch));
  const lc = S.spec.lightcurve.filter((r) => vis.has(r.epoch)), traces = [], used = lcDetectors(lc);
  const ep = S.epochs.filter((e) => !e.archival), pad = 12;
  const xr = ep.length ? [mjdToDate(Math.min(...ep.map((e) => e.mjd)) - pad), mjdToDate(Math.max(...ep.map((e) => e.mjd)) + pad)] : undefined;
  const note = (text) => ({ xref: "paper", yref: "paper", x: 1, y: 1.02, xanchor: "right", yanchor: "bottom", showarrow: false,
    text, font: { size: 10, color: "#8e9bb3" } });
  let yaxis, annotations = [], shapes = [];
  if (used.length) {
    // source detected: each detector normalised to its median, so variability in different colours can be compared
    used.forEach((d) => {
      const g = lc.filter((r) => r.det === d);
      const med = [...g.map((r) => r.flux_mjy)].sort((a, b) => a - b)[g.length >> 1] || 1;
      const norm = Math.abs(med) > 1e-6 ? med : 1;
      traces.push({ x: g.map((r) => mjdToDate(r.mjd)), y: g.map((r) => r.flux_mjy / norm), mode: "lines+markers", type: "scatter", name: d,
        line: { color: DET_COLORS[d], width: 1.5 }, marker: { size: 7 },
        error_y: { type: "data", array: g.map((r) => (r.err_mjy || 0) / Math.abs(norm)), visible: true, thickness: 1, width: 0 },
        hovertemplate: `${d}: %{y:.2f}× median<br>%{x}<extra></extra>` });
    });
    const skipped = DETS.filter((d) => lc.some((r) => r.det === d) && !used.includes(d));
    if (skipped.length) annotations.push(note(`not detected in ${skipped.join(", ")}`));
    const log = lcLog(), ticks = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
    yaxis = { ...PLOT_LAYOUT.yaxis, title: "Flux / median", type: log ? "log" : "linear",
      ...(log ? { tickvals: ticks, ticktext: ticks.map(String) } : {}) };   // explicit labels ("0.5", not "5")
  } else if (lc.length) {
    // nothing detected (empty sky or a very faint source): show the measured fluxes in mJy around zero
    DETS.forEach((d) => {
      const g = lc.filter((r) => r.det === d);
      if (!g.length) return;
      traces.push({ x: g.map((r) => mjdToDate(r.mjd)), y: g.map((r) => r.flux_mjy), mode: "lines+markers", type: "scatter", name: d,
        line: { color: DET_COLORS[d], width: 1, dash: "dot" }, marker: { size: 6 }, opacity: 0.85,
        error_y: { type: "data", array: g.map((r) => r.err_mjy || 0), visible: true, thickness: 1, width: 0 },
        hovertemplate: `${d}: %{y:.3f} mJy<br>%{x}<extra></extra>` });
    });
    shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: 0, y1: 0, line: { color: "rgba(200,210,230,.4)", width: 1 } }];
    annotations.push(note(S.result && S.result.partial ? "no clear source yet – still measuring" : "No source detected here – click a star in the image to see its light curve"));
    yaxis = { ...PLOT_LAYOUT.yaxis, title: "Flux (mJy)", type: "linear", zeroline: false };
  } else {
    annotations.push(note(S.result && S.result.partial ? "waiting for the first measurements…" : "no measurements in this date range"));
    yaxis = { ...PLOT_LAYOUT.yaxis, title: "Flux / median", type: "linear" };
  }
  Plotly.react("lcPlot", traces, { ...PLOT_LAYOUT, xaxis: { ...PLOT_LAYOUT.xaxis, type: "date", range: xr }, yaxis, annotations, shapes },
    { displayModeBar: false, responsive: true });
}
function lcDetectors(lc = S.spec?.lightcurve || []) {   // detectors where the source is detected (median flux > 3x its uncertainty)
  return DETS.filter((d) => {
    const g = lc.filter((r) => r.det === d);
    if (g.length < 2) return false;
    const f = g.map((r) => r.flux_mjy).sort((a, b) => a - b), med = f[f.length >> 1];
    const errs = g.map((r) => r.err_mjy).filter((e) => e > 0).sort((a, b) => a - b);
    const mad = 1.4826 * f.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[f.length >> 1] / Math.sqrt(f.length);
    const e = Math.max(errs.length ? errs[errs.length >> 1] / Math.sqrt(g.length) : 0, 0);
    return med > 0 && med > 3 * Math.max(e, Math.min(mad, med / 3.01));
  });
}
function lcLog() {   // large-amplitude variables (e.g. Miras) read better on a log axis
  const lc = S.spec?.lightcurve || [], used = lcDetectors();
  return used.some((d) => {
    const f = lc.filter((r) => r.det === d && r.flux_mjy > 0).map((r) => r.flux_mjy);
    return f.length > 2 && Math.max(...f) / Math.min(...f) > 4;
  });
}
function mjdToDate(m) { return new Date((m - 40587) * 86400000).toISOString().slice(0, 10); }

// ---------------------------------------------------------------- interaction
function setHash() {
  if (!S.target) return;
  const t = S.target, h = new URLSearchParams();
  if (t.sso) h.set("object", t.name);
  else if (t.id) h.set("target", t.id);
  else { h.set("ra", t.ra.toFixed(6)); h.set("dec", t.dec.toFixed(6)); if (t.pmra) h.set("pmra", t.pmra); if (t.pmdec) h.set("pmdec", t.pmdec); if (t.ref_epoch && t.ref_epoch !== 2000) h.set("epoch", t.ref_epoch); if (t.name) h.set("name", t.name); }
  h.set("fov", S.fov); h.set("mode", S.mode); h.set("dets", [...S.dets].join(","));
  const dr = dateRange(); if (dr.from) h.set("from", dr.from); if (dr.to) h.set("to", dr.to);
  h.set("speed", $("speed").value); if (!$("invert").checked) h.set("invert", "0"); if (+$("zoom").value !== 1) h.set("zoom", $("zoom").value);
  if (S.mode === "track") {
    const p = trkParams();
    h.set("dist", Math.round(p.d)); if (p.ve) h.set("ve", p.ve); if (p.vn) h.set("vn", p.vn);
  }
  if (S.embed) h.set("embed", "1");
  history.replaceState(null, "", "#" + h.toString());
  $("openFull").href = viewUrl(false);
}
function setMode(m) {
  if (m === "track" && isMoving()) return;   // Solar System object frames are already centred on the object
  if (m === "track") TRK.failed.clear();
  S.mode = m; document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("tracker").hidden = m !== "track";
  setHash(); rebuildDisplay(); trkNote();
}
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/* A rejected search: say what is wrong and show the accepted formats as clickable examples. */
function inputHelp(message) {
  S.pending = null; showProgress(false);
  const ex = [["269.452 4.693", "decimal degrees"], ["08:55:10.8 -07:14:42", "hours and degrees"],
              ["Barnard's Star", "a name known to SIMBAD"], ["M 31", "catalogue name"]];
  $("empty").hidden = false;
  $("empty").innerHTML = `<p><b>${esc(message)}</b></p>
    <p class="small">Accepted input (click an example to try it):</p>
    <p class="examples">${ex.map(([q, what]) => `<button type="button" data-q="${esc(q)}">${esc(q)}<span class="k">${what}</span></button>`).join("")}</p>
    <p class="small">RA runs from 0° to 360° (or 0h to 24h), Dec from −90° to +90°.<br>
    Names follow SIMBAD spelling, e.g. <i>WISE J085510.83-071442.5</i>. Asteroids and comets: switch the menu to “Solar System object”.</p>`;
  $("empty").querySelectorAll("button[data-q]").forEach((b) => (b.onclick = () => { $("q").value = b.dataset.q; submitQuery(b.dataset.q); }));
}
async function submitQuery(text) {
  const fov = +$("fov").value;
  if ($("qmode").value === "sso") return loadObject(text, fov);
  const c = parseCoords(text);
  if (c) {
    if (Number.isNaN(c.ra)) return inputHelp("Minutes and seconds in a position must be below 60.");
    if (!(c.ra >= 0 && c.ra < 360 && Math.abs(c.dec) <= 90))
      return inputHelp(`These coordinates are outside the sky: RA ${fmt(c.ra, 3)}°, Dec ${fmt(c.dec, 3)}°.`);
    return loadTarget({ name: null, ra: c.ra, dec: c.dec, pmra: 0, pmdec: 0, ref_epoch: 2000 }, fov);
  }
  if (!/[a-z]/i.test(text)) return inputHelp(`“${text}” is not a complete position: give both RA and Dec.`);
  try {
    const r = await api(`/api/resolve?q=${encodeURIComponent(text)}`);
    loadTarget(r, fov);
  } catch (err) {
    inputHelp(err.message);
  }
}
function setFovOption(v) {
  if (!(v >= 1 && v <= 20)) return;
  const sel = $("fov");
  if (![...sel.options].some((o) => +o.value === v)) {
    const o = document.createElement("option"); o.value = v; o.textContent = `${v}′`;
    sel.appendChild(o);
    [...sel.options].sort((a, b) => a.value - b.value).forEach((x) => sel.appendChild(x));
  }
  sel.value = String(v);
}
async function initFromHash(targets) {
  const h = new URLSearchParams(location.hash.slice(1));
  S.embed = h.get("embed") === "1";            // embed=1: viewer only, for <iframe> use on other sites
  document.body.classList.toggle("embed", S.embed);
  if (h.get("fov")) setFovOption(+h.get("fov"));
  if (h.get("mode")) S.mode = h.get("mode");
  if (+h.get("dist") > 0) $("trkDist").value = Math.log10(Math.min(4000, Math.max(25, +h.get("dist"))));
  $("trkVe").value = +h.get("ve") || 0; $("trkVn").value = +h.get("vn") || 0;
  $("tracker").hidden = S.mode !== "track"; trkNote();
  if (h.get("dets")) S.dets = new Set(h.get("dets").split(",").filter((d) => DETS.includes(d)));
  // always follow the link (also cleared): a saved-candidate link opened later must not inherit old dates
  $("dFrom").value = /^\d{4}-\d{2}-\d{2}$/.test(h.get("from") || "") ? h.get("from") : "";
  $("dTo").value = /^\d{4}-\d{2}-\d{2}$/.test(h.get("to") || "") ? h.get("to") : "";
  updateDatesSummary();
  if (!h.get("object")) setQmode("sky");
  if (h.get("speed")) $("speed").value = h.get("speed");
  if (h.get("invert") === "0") $("invert").checked = false;
  if (h.get("zoom")) $("zoom").value = h.get("zoom");
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
  const fov = +$("fov").value;
  if (h.get("object")) { setQmode("sso"); return loadObject(h.get("object"), fov); }
  if (h.get("target")) {
    const t = targets.find((x) => x.id === h.get("target"));
    if (t) return loadTarget(t, fov);
  }
  if (h.get("ra") && h.get("dec")) {
    return loadTarget({ name: h.get("name"), ra: +h.get("ra"), dec: +h.get("dec"), pmra: +(h.get("pmra") || 0),
      pmdec: +(h.get("pmdec") || 0), ref_epoch: +(h.get("epoch") || 2000) }, fov);
  }
}

async function main() {
  let targets = [];
  try { targets = await api("/api/targets"); } catch { /* offline */ }
  api("/api/index").then((i) => {   // how recent the searchable SPHEREx data is
    if (i.available) $("indexNote").textContent = ` Searchable SPHEREx images: up to ${mjdToDate(i.mjd_max)} (index updated ${i.built.slice(0, 10)}).`;
  }).catch(() => {});
  // names only (less clutter); what each target is shows in a tooltip on hover/focus
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  $("demos").innerHTML = targets.map((t) => `<button data-id="${t.id}" data-kind="${esc(t.kind)}" data-tip="${esc(t.note)}" aria-label="${esc(t.name)}: ${esc(t.kind)}">${esc(t.name)}</button>`).join("")
    + `<button class="sso" data-obj="3I" data-kind="interstellar comet" data-tip="Third interstellar object ever found; SPHEREx imaged it in August and December 2025 (opens in moving-object mode)." aria-label="3I/ATLAS: interstellar comet">3I/ATLAS</button>`;
  $("demos").querySelector("[data-obj]").onclick = () => { setQmode("sso"); loadObject("3I", 4); };
  $("demos").querySelectorAll("button[data-id]").forEach((b) => (b.onclick = () => {
    setQmode("sky");
    const t = targets.find((x) => x.id === b.dataset.id);
    if (t.id === "wise0855" || t.id === "eps_ind_b") { S.dets = new Set(["D5", "D6"]); }
    else if (t.id === "barnard") { S.dets = new Set(["D2", "D3"]); }
    else { S.dets = new Set(DETS); }
    loadTarget(t, +$("fov").value);
  }));
  $("searchForm").onsubmit = (e) => { e.preventDefault(); if ($("q").value.trim()) submitQuery($("q").value.trim()); };
  $("playBtn").onclick = () => play(!S.playing);
  $("prevBtn").onclick = () => { play(false); step(-1); };
  $("nextBtn").onclick = () => { play(false); step(1); };
  document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  ["lo", "hi"].forEach((id) => ($(id).oninput = () => { computeLimits(); render(); }));
  ["asinh", "invert"].forEach((id) => ($(id).oninput = () => { render(); setHash(); }));
  $("zoom").oninput = () => { render(); setHash(); };
  $("speed").oninput = () => setHash();
  ["ovTarget", "ovGaia", "ovBorder", "ovCand"].forEach((id) => ($(id).onchange = drawOverlay));
  $("ovArch").onchange = () => { rebuildDisplay(); showMotionBadge(); };
  ["trkDist", "trkVe", "trkVn"].forEach((id) => ($(id).oninput = trkRedraw));
  $("saveCand").onclick = addSaved;
  $("savedCsv").onclick = downloadSaved;
  $("copyLink").onclick = () => share(viewUrl(false), $("copyLink"));
  $("copyEmbed").onclick = () => share(`<iframe src="${viewUrl(true)}" width="600" height="760" style="border:0" loading="lazy" title="SPHEREx Time Machine"></iframe>`, $("copyEmbed"));
  renderSaved();
  window.addEventListener("hashchange", () => initFromHash(targets));   // opening a saved candidate link
  ["dFrom", "dTo"].forEach((id) => ($(id).onchange = onRangeChange));
  $("clearDates").onclick = () => { $("dFrom").value = ""; $("dTo").value = ""; $("datesPop").open = false; onRangeChange(); };
  document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { setQmode(b.dataset.q); $("q").focus(); }));
  document.addEventListener("click", (ev) => { if ($("datesPop").open && !$("datesPop").contains(ev.target)) $("datesPop").open = false; });
  $("aboutBtn").onclick = () => $("aboutDlg").showModal();
  $("objectCardMore").onclick = () => setObjectCardCompact(!$("objectCard").classList.contains("compact"));
  // "where discoveries are reported" (team's discovery card): the list under the heading opens and closes (closed at first)
  const showReportBody = (open) => { $("reportBody").hidden = !open; $("reportToggle").setAttribute("aria-expanded", String(open)); };
  $("reportToggle").onclick = () => showReportBody($("reportBody").hidden);
  $("dTo").max = new Date().toISOString().slice(0, 10);
  $("pickLoad").onclick = () => {
    if (!S.pick) return;
    setQmode("sky");
    loadTarget({ name: null, ra: S.pick.ra, dec: S.pick.dec, pmra: 0, pmdec: 0, ref_epoch: 2000 }, Math.min(+$("fov").value || 5, 12));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  $("survey").onchange = async () => {
    const al = await ensureAladin();
    if (!al) return;
    (al.setBaseImageLayer || al.setImageSurvey).call(al, $("survey").value);
  };
  $("ovAst").onchange = () => { if ($("ovAst").checked && !S.ast && S.result) fetchAsteroids(); else drawOverlay(); };
  $("specReset").onclick = () => {
    S.spec = { points: S.result.points, lightcurve: S.result.lightcurve }; S.specLabel = { name: "target" };
    $("specTitle").textContent = "Spectrum at target"; $("specReset").hidden = true; plotSpectrum(); plotLightcurve(); drawOverlay();
  };
  $("objectCardClose").onclick = closeObjectCard;
  const ov = $("overlay");
  ov.addEventListener("mousemove", (ev) => {
    if (!S.result) return;
    const r = ov.getBoundingClientRect(), cx = ((ev.clientX - r.left) / r.width) * ov.width, cy = ((ev.clientY - r.top) / r.height) * ov.height;
    const [x, y] = fromCanvas(cx, cy), [ra, dec] = pix2world(x, y);
    $("readout").textContent = isMoving() ? "object-centred frame" : `${sexa(ra, true)} ${sexa(dec)}`;
  });
  ov.addEventListener("click", async (ev) => {
    if (!S.result) return;
    if (isMoving()) { showMovingObjectCard(); return; }
    const r = ov.getBoundingClientRect(), cx = ((ev.clientX - r.left) / r.width) * ov.width, cy = ((ev.clientY - r.top) / r.height) * ov.height;
    const [ra, dec] = pix2world(...fromCanvas(cx, cy));
    resolveObjectAt(ra, dec);
    S.specLabel = { ra, dec }; drawOverlay();
    $("specTitle").textContent = `Measuring at ${sexa(ra, true)} ${sexa(dec)}…`;
    const slow = setTimeout(() => { if (S.specLabel && S.specLabel.ra === ra) $("specTitle").textContent =
      `Measuring at ${sexa(ra, true)} ${sexa(dec)}… (first click in a stored field: loading its images, up to ~30 s)`; }, 4000);
    try {
      S.spec = await api(`/api/spectrum/${S.key}?ra=${ra}&dec=${dec}`);
      clearTimeout(slow);
      $("specTitle").textContent = `Spectrum at ${sexa(ra, true)} ${sexa(dec)}`;
      $("specReset").hidden = false; plotSpectrum(); plotLightcurve();
      if (S.selectedObject) renderSpherexConnection(S.selectedObject);
    } catch (err) { clearTimeout(slow); $("specTitle").textContent = `Spectrum: ${err.message}`; }
  });
  document.addEventListener("keydown", (ev) => {
    if (document.getElementById("team-view")?.inert) return;   // opening screen still shown
    if (ev.target.matches("input[type=text], select")) return;
    const k = ev.key.toLowerCase();
    if (k === "escape" && $("objectCard").classList.contains("open")) closeObjectCard();
    else if (k === " ") { ev.preventDefault(); play(!S.playing); }
    else if (k === "arrowleft") { play(false); step(-1); }
    else if (k === "arrowright") { play(false); step(1); }
    else if (k === "b") setMode("blink"); else if (k === "d") setMode("diff"); else if (k === "c") setMode("color");
    else if (k === "s") setMode("stack");
    else if (k === "t") setMode("track");
    else if (k === "i") { $("invert").checked = !$("invert").checked; render(); setHash(); }
    else if (k === "+" || k === "=") { $("zoom").value = Math.min(4, +$("zoom").value + 0.25); render(); }
    else if (k === "-") { $("zoom").value = Math.max(1, +$("zoom").value - 0.25); render(); }
  });
  window.addEventListener("load", () => { if (S.spec) { plotSpectrum(); plotLightcurve(); } });
  await initFromHash(targets);
  if (!S.target) showSkyStart();   // nothing to load from the link: show the sky right away
}
main();
