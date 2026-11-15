# SPHEREx Time Machine

**Blink the infrared sky. Spot what moves. Read its spectrum.**

**Live tool: https://spherex-time-machine.onrender.com** (free hosting: the first visit after a quiet period can take ~1 minute to wake up).

Try: [WISE 0855 difference](https://spherex-time-machine.onrender.com/#target=wise0855&mode=diff&dets=D5,D6) · [Barnard's Star](https://spherex-time-machine.onrender.com/#target=barnard&dets=D2,D3) · [R Draconis light curve](https://spherex-time-machine.onrender.com/#target=r_dra) · [Interstellar comet 3I/ATLAS](https://spherex-time-machine.onrender.com/#object=3I&fov=4&mode=stack)

A public web tool for the NASA Space Apps Challenge 2026 *"Planet X and SPHEREx"*. Enter a sky position or an object name, and the tool shows a series of NASA SPHEREx images of that patch of sky like a short movie, making moving and variable objects easy to see. Click anywhere to get an on-the-fly 0.75–5 µm spectrum.

## Features

- **Blink** SPHEREx images of any position, one frame per visit (DR1 + QR3 + deep fields, found in our own index of the public archive; a new release is added with two scripts, see "Keeping up with new SPHEREx data").
- **Six detector arrays** selectable individually or combined; frames are co-added per visit and detector for signal-to-noise.
- **Difference mode**: each visit minus the median of the other visits. Static stars cancel; movers leave a dipole.
- **Parallax tracker** (*Track* mode, for bodies far beyond Neptune): the normal frames are a median of all images of a visit (10–40 days), which smears or removes anything that moves during the visit. Track shifts the single images of each visit along the path of a body at a trial **distance** (25–4000 AU; its apparent motion comes mostly from the Earth's own motion) plus an optional on-sky rate for its orbit, and median-stacks them: at the right distance the body adds up while stars smear. A body at 100 AU moves ~17 px during a 15-day visit, at 300 AU ~5 px (SPHEREx looks ~90° from the Sun, where this drift is smallest, so the gain is largest out to a few hundred AU). The model was checked against JPL Horizons for Eris, Makemake, Sedna and Neptune: < 0.4 px over 40 days. Test on real data: Pluto moved 49 px during its Sep–Oct 2025 visit and is absent from the normal frame; tracked at 35 AU it stacks into one source of 92σ (8.7σ at 25 AU, 7.2σ at 200 AU) within 0.5 px of its JPL position. Try it: [Pluto, tracked](https://spherex-time-machine.onrender.com/#ra=304.14974&dec=-23.61619&name=Pluto&fov=8&from=2025-09-23&to=2025-10-14&mode=track&dist=35&ve=17.53&vn=-1.16&dets=D1,D2,D3,D4,D5,D6) (first load ~1–2 min).
- **False-colour mode** (blue = D1+D2, green = D3+D4, red = D5+D6) and **D6−D4 mode**: cold brown dwarfs are bright at 4.5 µm but dark in the 3.3 µm methane band.
- **Proper-motion aware**: named targets are propagated to the SPHEREx epochs. High-proper-motion stars (Barnard's Star moved 4.4′ since J2000; WISE 0855 sits ~2′ from its catalogue position) are found automatically, and the predicted track is drawn on the images.
- **On-the-fly spectrum and light curve** at the target or at any clicked position, coloured by visit, with molecular bands (H₂O, CH₄, CO₂, CO) and emission lines marked. Fluxes come from forced photometry with the SPHEREx effective PSF, fitted simultaneously with neighbouring Gaia DR3 stars so blended light is removed (WISE 0855 sits 8″ from a G = 16 star: after deblending its spectrum is dark below 3.8 µm and matches the published WISE W2 and Spitzer 3.6 µm fluxes).
- **Automatic candidate boxes** on the difference images: *mover?* (positive/negative dipole), *variable?*, and *one visit only* (asteroid, transient or artifact). Hints for human eyes, with cosmic-ray, bright-star and saturation safeguards.
- **Measured proper motion**: per-visit centroids are fitted to measure the target's motion directly from SPHEREx and compare it with the catalogue value.
- **25-year baseline**: archival 2MASS (1997–2001) and AllWISE (2010) images of the same field are fetched from IRSA, reprojected onto the SPHEREx grid and added as extra blink/difference frames (2000 → 2010 → 2025 → 2026). WISE 0855 jumps ~2′ across the field; including the WISE epoch tightens its measured motion to 8.20 ± 0.03″/yr (catalogue 8.15″/yr).
- **Solar System object mode** (IRSA MOST): follow an asteroid or comet through every SPHEREx image, with object-centred frames and a shift-and-add *Stack* mode. Demo: interstellar comet 3I/ATLAS.
- **Overlays**: Gaia DR3 (propagated to each visit from J2016.0, fast movers drawn with motion arrows), known asteroids and comets (JPL Small-Body Identification), target track.
- **"No Gaia counterpart" badge**: a moving source invisible to Gaia is too cold for optical light – the classic brown-dwarf signature used by citizen scientists.
- **Data-quality notes** from SPHEREx pixel flags (ghosts, streaks, cosmic rays, persistence) at the measured position; frames with heavy transient contamination are skipped.
- **Candidate list**: click a source, press "Save as candidate", and download your list as CSV (coordinates, visit date, Gaia match within 4″, link back to the view) to share with a science team. Saved positions are marked with a small yellow ★ square. The list stays in the browser; nothing is uploaded.
- **Shareable URLs**: every setting lives in the URL, e.g. `/#target=wise0855&mode=diff&dets=D5,D6` or `/#ra=269.452&dec=4.693&pmra=-802&pmdec=10362&fov=8`; "Copy link" copies the current view.
- **Embeddable**: add `&embed=1` for a viewer-only page, or use "Copy embed code" for a ready `<iframe>` snippet: `<iframe src="https://spherex-time-machine.onrender.com/#target=wise0855&mode=diff&dets=D5,D6&embed=1" width="600" height="760"></iframe>`.
- **Input help**: positions outside the sky, minutes or seconds of 60 or more, incomplete coordinates and unknown names get a clear message with clickable examples of the accepted formats. Names are resolved by SIMBAD (Harvard mirror) and CDS Sesame; "no such object" and "name services unreachable" are reported separately.
- **Links out**: WiseView (13 years of WISE), SIMBAD, CADC SSOIS (other telescopes at this position), Legacy Survey, IRSA SPHEREx Data Explorer.
- Keyboard: Space play/pause · ← → step · B/D/C modes · I invert · + − zoom.

## Running locally

```bash
python3 -m venv .venv
.venv/bin/pip install astropy astroquery numpy reproject fastapi uvicorn
.venv/bin/uvicorn main:app --app-dir backend --port 8000
# open http://localhost:8000
```

Optional – pre-compute the demo targets so they load instantly:

```bash
.venv/bin/python scripts/warm_cache.py 5
```

## Keeping up with new SPHEREx data

- Images are found in our own index (`data/index/`). To pick up a new Quick Release or Data Release, run `python scripts/list_s3.py` and then `python scripts/build_index.py`. The listing finds release folders in the bucket by itself (no release name is hard-coded; when a week is in several releases, a Data Release beats a Quick Release and a newer number beats an older one), and the index build only reads the files that are not in the index yet. Without the index file, the tool falls back to the live IRSA TAP query.
- The page shows how recent the index is ("Searchable SPHEREx images: up to …", from `/api/index`).
- A finished field is stored in `data/results/` and served from there afterwards. The "Latest image" badge shows the date of the newest SPHEREx image in the stored field.
- To refresh stored fields after a release, delete `data/results/*.json` and run `scripts/warm_cache.py 5` again. If the processing itself changes, raise `PIPELINE_VERSION` in `backend/pipeline.py` instead; old results are then ignored.

## How it works

```
Browser (vanilla JS, canvas, Plotly)          FastAPI backend (Python)
  blink / difference / colour rendering  <--   /api/frames   own index -> AWS cutouts -> clean -> reproject -> co-add
  stretch, invert, zoom (instant)              /api/spectrum aperture photometry on every image
  WCS (TAN) for overlays & clicks              /api/gaia     ESA Gaia archive (MAST fallback)
  URL state, keyboard                          /api/asteroids JPL sb_ident
                                               /api/resolve  built-in targets, SIMBAD (Harvard), CDS Sesame
                                               disk cache of cutouts and results
```

- **Finding images – our own index, no database query.** All 1.63 million SPHEREx Level-2 images (273,000 exposures) are indexed by `scripts/build_index.py`, which reads ~9 kB of each 65 MB file in the public AWS copy (`s3://nasa-irsa-spherex`). D1+D4, D2+D5 and D3+D6 see the same sky and D1–D3 sit side by side, so one pointing per exposure plus a fixed focal-plane map describes all six footprints. Each exposure is stored as a 3-D unit vector, so "which images cover this position?" becomes one dot product per exposure (a 3-D search reduced to comparing a single number), followed by a vectorised gnomonic projection of the candidates: a few milliseconds, and it keeps working when the IRSA database is down. The IRSA TAP service (`spherex.artifact`/`spherex.plane`) is the fallback.
- **Cutouts straight from the cloud.** Level-2 images are uncompressed FITS, so a cutout is a handful of HTTP range requests (headers, the rows that cover the box, the row-compressed FLAGS tiles, one ePSF zone, the spectral WCS). The result is pixel-for-pixel identical to an IRSA cutout; the IRSA cutout service is the fallback.
- **Live charts.** Every image is measured as soon as it arrives, so the spectrum and light curve fill in while the frames are still sharpening.
- **Choose the dates.** Optional *Dates* inputs restrict everything (blink, difference, candidates, measured motion, spectrum, light curve) to the visits in that range – instantly for a loaded field, and a new field only downloads those visits. Ranges reaching back to 2010 or 2000 add the archival WISE and 2MASS frames; a range without visits lists the dates the position was observed. The range is part of the URL (`&from=2025-01-01&to=2025-12-31`).
- **Progressive loading.** For a position never loaded before, the detectors on screen are processed first, first and last visit before the others, and each stage is shown as soon as it is ready; the remaining detectors and the spectrum follow in the background while the animation plays. All downloads are queued up front in that order so network and processing overlap. Loaded fields open instantly.
- Cleaning: zodiacal light model (ZODI extension) subtracted; pixels with bad FLAGS bits masked (Explanatory Supplement Table 16); per-image background removed.
- Alignment: every cutout reprojected onto a common north-up TAN grid (6.15″ pixels) with `reproject`.
- Co-addition: one inverse-variance–weighted frame per (visit, detector); the browser normalises and combines detectors on the fly.
- Spectrum: each SPHEREx pixel has its own wavelength (linear variable filter); per-image forced PSF photometry (ePSF extension of each image, weighted by the variance map, fitted together with Gaia DR3 neighbours and a local background) at the target position for that image's date gives one spectral point per image. Saturated stars are measured on their unsaturated PSF wings (relative fluxes only).

## Data and resources

**NASA:** SPHEREx DR1 (DOI 10.26131/IRSA678) and QR3 (DOI 10.26131/IRSA662) spectral images via NASA/IPAC IRSA; SPHEREx Explanatory Supplement; IRSA SPHEREx tutorial notebooks; IRSA MOST; JPL Small-Body Identification API; WiseView (inspiration).
**Space agency partners:** ESA Gaia DR3; Canadian Space Agency NEOSSat tutorial and Canadian Astronomy Data Centre (SSOIS, DSS).
**Other:** SIMBAD (Harvard mirror) and CDS Sesame name resolvers; astropy, astroquery, reproject, FastAPI, Plotly.js.

### Acknowledgements

This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration. This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by NASA and operated by the California Institute of Technology. This work has made use of data from the European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium. This research used the facilities of the Canadian Astronomy Data Centre operated by the National Research Council of Canada with the support of the Canadian Space Agency.

This is not an official NASA product and does not imply endorsement by NASA, JPL, Caltech, ESA or CSA.

## Use of AI (Super Intelligence) tools

As required by the NASA Space Apps rules, we disclose that an AI coding assistant (Claude, by Anthropic) was used during the hackathon to help survey the challenge resources and to draft parts of the code (backend pipeline, API server and frontend). Files containing AI-assisted code say so in their header comment. The team chose the challenge, made the design decisions, and reviewed, tested and is responsible for all code and results.

Project demo video: it was recorded from the live website by a script and edited with the help of the same AI coding assistant. Its English voice-over is AI-generated speech (Kokoro, an open-source text-to-speech model, run locally), and the video carries a visible watermark saying so. All screens in the video are real captures of SkyBlink.

The two background images of the website (the nebula behind the page and the opening screen) are AI-generated; the site shows a visible "Background images: AI-generated" notice. No other AI-generated images, audio or video are used.

## License

MIT (see LICENSE). Third-party data remain subject to their providers' terms.
