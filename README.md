# Indicator colour test (biological indicators)

**Test tool only. Not for sterilisation decisions.**

A single web page that checks whether a phone browser can tell the colour of a self-contained biological indicator after incubation:

| Colour of the liquid | Result shown |
|---|---|
| Purple | Fără creștere bacteriană - Procesul a avut succes |
| Yellow / green | Creștere bacteriană - Proces eșuat! |
| Anything not clearly one of these | Rezultat incert - Repetați citirea |

A purple reading only means "no colour change". It is meaningful only for a vial that was processed, activated and incubated for its full reading time. The tool cannot see any of that.

Everything runs on the phone. There is no backend, no upload, no analytics, and the page's Content Security Policy blocks all network requests. Results stay in the browser until you export them.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page |
| `app.js` | Camera, region selection, calibration, log, export, capability report |
| `colour.js` | Colour maths: sRGB → CIELAB, CIEDE2000, white-reference correction, classification |
| `tests/colour.test.js` | `node tests/colour.test.js` checks the colour maths |
| `RESULTS_TEMPLATE.md` | One sheet per phone + browser, so sessions can be compared |

## Hosting

The camera needs HTTPS. The page is served by GitHub Pages from the `main` branch root:
https://limas-dev-986.github.io/camscanner-test/

(Settings → Pages → Deploy from a branch → `main` / `/ (root)`.) After a push, Pages updates in about a minute. The build number at the bottom of the page shows which version a phone loaded. If it's old, reload the page.

The repository is **public**. Never commit exported logs, real results, product or manufacturer names, or customer details. `.gitignore` blocks `*.csv` and `*.json` as a safety net.

## Running a test session

1. **Open the page** on the phone in the browser being tested (Chrome first). Allow camera access.
2. **Session (section 4):** enter a device label (e.g. `Phone A – budget Android`) and your initials. No full names.
3. **Start camera.** If the phone has several rear cameras, pick the main one in the drop-down.
4. **Capability report (section 8):** export it once per phone + browser. It shows which camera controls the browser exposes.
5. **Camera locks (optional):** lock exposure / white balance / focus where available. The test plan runs every condition both in automatic and in locked mode.
6. **Position the vial** at a fixed distance (about 10–15 cm), with the liquid and the white part of the label both in view. Avoid reflections on the plastic.
7. **Capture**, then tap:
   - the **liquid** at the bottom of the vial. **Never the cap: the cap is always purple, so tapping it gives a false "no growth".**
   - the **white area of the label** (white reference), or *Skip white reference*.
   Make the region small enough to sit fully inside the liquid. If the result says "region not uniform", the box covers an edge, text or a reflection.
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

1. The selected region is averaged in linear light. Saturated pixels (glare) are excluded and counted.
2. Optional white-reference correction: each channel is scaled so the white label becomes neutral at a fixed level. This removes most of the colour cast from the lighting and evens out exposure.
3. The average is converted to CIELAB and LCh (lightness, chroma, hue angle).
4. Rules, in this order:
   - Hue in the yellow/green band with enough chroma → **colour change**, even if the region quality is imperfect (fail-safe direction).
   - Too much glare, region not uniform, too dark or too bright, or too grey → **uncertain**.
   - Hue in the purple band → **no colour change**, but only if (when calibrated) it is close enough to the purple reference *and* clearly closer to purple than to yellow. Otherwise **uncertain**.
   - Anything else → **uncertain** (or colour change if clearly nearest the yellow reference).

A colour change is never upgraded to "no colour change". **A yellow or green vial read as purple is an unsafe error.** The log flags it, and the test plan treats any occurrence as a stop signal.

Thresholds are editable in section 7. Change them only between sessions and record the change in the results template. Every log row stores the thresholds used.

## Known limitations

- The tool cannot tell the purple cap from purple liquid. The tester must tap the liquid.
- Phone cameras process colour automatically (white balance, tone mapping). That is exactly what this test measures.
- On iPhone, all browsers use Apple's WebKit engine, which is expected to expose fewer camera controls than Chrome on Android. The capability report records what is available.
- CSV uses comma separators and dot decimals. In Excel with Romanian regional settings, import via *Data → From Text/CSV* and set the delimiter to comma.
