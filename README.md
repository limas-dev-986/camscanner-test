# Indicator colour test

**Test tool only. Not for sterilisation decisions.**

A single web page that checks whether a phone browser can read the colour change of sterilisation test objects. Choose the object at the top of the page.

| Object | Pass | Fail | Result shown (pass / fail) |
|---|---|---|---|
| Biological indicator, self-contained vial | Liquid stays purple | Liquid turns yellow / green | Fără creștere bacteriană - Procesul a avut succes / Creștere bacteriană - Proces eșuat! |
| Bowie & Dick test sheet | Pink stripes turned uniformly black | Pink left, or lighter / uneven areas | Virare completă la negru - Test trecut / Virare incompletă - Test eșuat! |

Anything not clearly pass or fail shows "Rezultat incert - Repetați citirea".

A purple vial reading only means "no colour change". It is meaningful only for a vial that was processed, activated and incubated for its full reading time. The tool cannot see any of that.

Everything runs on the phone. There is no backend, no upload, no analytics, and the page's Content Security Policy blocks all network requests. Results stay in the browser until you export them.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page |
| `app.js` | Camera, region selection, calibration, log, export, capability report |
| `products.js` | The list of objects (add new ones here) |
| `colour.js` | Colour maths: sRGB → CIELAB, CIEDE2000, white-reference correction, vial classification, sheet analysis |
| `tests/colour.test.js` | `node tests/colour.test.js` checks the colour maths |
| `RESULTS_TEMPLATE.md` | One sheet per phone + browser, so sessions can be compared |

## Hosting

The camera needs HTTPS. The page is served by GitHub Pages from the `main` branch root:
https://limas-dev-986.github.io/camscanner-test/

(Settings → Pages → Deploy from a branch → `main` / `/ (root)`.) After a push, Pages updates in about a minute. The build number at the bottom of the page shows which version a phone loaded. If it's old, reload the page.

The repository is **public**. Never commit exported logs, real results, product or manufacturer names, or customer details. `.gitignore` blocks `*.csv` and `*.json` as a safety net.

## Running a test session

1. **Open the page** on the phone in the browser being tested (Chrome first). Allow camera access. **Choose the object to test** at the top.
2. **Session (section 4):** enter a device label (e.g. `Phone A – budget Android`) and your initials. No full names.
3. **Start camera.** If the phone has several rear cameras, pick the main one in the drop-down.
4. **Capability report (section 8):** export it once per phone + browser. It shows which camera controls the browser exposes.
5. **Camera locks (optional):** lock exposure / white balance / focus where available. The test plan runs every condition both in automatic and in locked mode.
6. **Position the vial** at a fixed distance (about 10–15 cm), with the liquid and the white part of the label both in view. Avoid reflections on the plastic.
7. **Capture**, then select the region. For a **vial**, tap:
   - the **liquid** at the bottom of the vial. **Never the cap: the cap is always purple, so tapping it gives a false "no growth".**
   - the **white area of the label** (white reference), or *Skip white reference*.
   Make the region small enough to sit fully inside the liquid. If the result says "region not uniform", the box covers an edge, text or a reflection.

   For a **Bowie & Dick sheet**: lay the sheet flat, fill most of the frame with it, hold the phone parallel to it, and avoid shadows and reflections. Tap **one corner of the printed pattern**, then the **opposite corner**. Keep the selection inside the pattern (no table, no white margin). The overlay shows the areas analysed: green = OK, red = pink left, orange = lighter or fainter area, grey = not enough stripes.
8. **Tester input:** select the expected result (what you know the vial is), the lighting, the angle and a sample ID (e.g. `P1`, `Y2`). Then *Save to log*.
9. Repeat at least **5 captures per combination** (phone × lighting × camera mode × angle), as in the test plan.
10. **Export CSV and JSON** at the end of the session, and save them outside the repository folder.

### Calibration (recommended)

Without calibration, the tool uses fixed hue bands only. With calibration, a purple reading must also be close to your own purple samples and clearly further from your yellow samples.

1. Capture a vial you **know** is purple (no growth). In *Calibration*, tap *Save as PURPLE reference*. Repeat with 3–5 captures.
2. Do the same with a known yellow vial (e.g. a positive control) → *Save as YELLOW reference*.
3. References are kept separately for "with white reference" and "without white reference". Calibrate the mode you test in.
4. References are stored per phone and browser. The JSON export includes them.

Green samples are hard to obtain, so the yellow/green band is set wide on purpose. Any orange, yellow or green hue counts as a colour change.

## How the classification works

### Vial (biological indicator)

1. The selected region is averaged in linear light. Saturated pixels (glare) are excluded and counted.
2. Optional white-reference correction: each channel is scaled so the white label becomes neutral at a fixed level. This removes most of the colour cast from the lighting and evens out exposure.
3. The average is converted to CIELAB and LCh (lightness, chroma, hue angle).
4. Rules, in this order:
   - Hue in the yellow/green band with enough chroma → **colour change**, even if the region quality is imperfect (fail-safe direction).
   - Too much glare, region not uniform, too dark or too bright, or too grey → **uncertain**.
   - Hue in the purple band → **no colour change**, but only if (when calibrated) it is close enough to the purple reference *and* clearly closer to purple than to yellow. Otherwise **uncertain**.
   - Anything else → **uncertain** (or colour change if clearly nearest the yellow reference).

A colour change is never upgraded to "no colour change".

### Sheet (Bowie & Dick)

The selected pattern is split into a 5 × 5 grid of areas.

1. **Stripe vs paper:** in each area, the paper white is the brightest 10% of pixels. A pixel counts as stripe if it is clearly darker than the paper *of its own area*. That way a shadow or uneven light across the sheet is not mistaken for uneven darkening.
2. **Pink:** stripe pixels are colour-corrected using the sheet's paper white, then counted as pink if they have enough chroma and a magenta/pink/red hue.
3. **Per area:** pink share, median stripe darkness (relative L*, 0 = black), and stripe density.
4. Rules:
   - **Fail** if pink is left (≥ 10% of stripes overall, or ≥ 20% in any area), darkness differs clearly between areas (ΔL* ≥ 20, e.g. a lighter centre), stripes are clearly not dark, or an area has far fewer stripe pixels than the rest (stripes faded there).
   - **Pass** only if there is almost no pink (≤ 2% overall, ≤ 5% in any area), the stripes are dark (median L* ≤ 38), every area is evenly dark (ΔL* ≤ 12), and stripe density is even.
   - Anything in between, glare, or a selection with too few stripes → **uncertain**.

These starting values come from synthetic sheets and the manufacturer's colour-change scheme image. They must be checked against real processed sheets.

### Both objects

**A failed sample read as passed is an unsafe error.** The log flags it, and the test plan treats any occurrence as a stop signal.

Thresholds are editable in section 7, separately for each object. Change them only between sessions and record the change in the results template. Every log row stores the thresholds used.

## Adding an object

Append an entry to `products.js` (id, label, method `vial` or `sheet`, messages, expected-result labels). Use generic labels: the repository is public, so no manufacturer or product names. A new colour scheme that is neither "one region" nor "pattern sheet" needs a new method in `colour.js`.

## Known limitations

- The tool cannot tell the purple cap from purple liquid. The tester must tap the liquid.
- Bowie & Dick: the sheet selection is an axis-aligned rectangle. Hold the phone parallel to the sheet; a strongly tilted shot puts table or margin into the selection.
- Phone cameras process colour automatically (white balance, tone mapping). That is exactly what this test measures.
- On iPhone, all browsers use Apple's WebKit engine, which is expected to expose fewer camera controls than Chrome on Android. The capability report records what is available.
- CSV uses comma separators and dot decimals. In Excel with Romanian regional settings, import via *Data → From Text/CSV* and set the delimiter to comma.
