# Indicator colour test

**Test tool only. Not for sterilisation decisions.**

A single web page that checks whether a phone browser can read the colour change of sterilisation test objects. Choose the object at the top of the page.

| Object | Pass | Fail | Result shown (pass / fail) |
|---|---|---|---|
| Biological indicator, self-contained vial | Liquid stays purple | Liquid turns yellow / green | Fără creștere bacteriană - Procesul a avut succes / Creștere bacteriană - Proces eșuat! |
| Bowie & Dick test sheet | Pink stripes turned uniformly black | Pink left, or lighter / uneven areas | Virare completă - Test trecut / Virare incompletă - Test eșuat! |

| Type 5 chemical indicator, self-adhesive strip (steam) | All three triangles pink | Any triangle not pink (blue, violet) | Virare completă - Test trecut / Virare incompletă - Test eșuat! |

Anything not clearly pass or fail shows "Rezultat incert - Repetați citirea".

**Each object carries its own rules.** The reading method, colour limits and messages are stored with the object in `products.js`; choosing an object in the list applies them. The same colour can mean opposite things on different objects (pink is a fail on the Bowie & Dick sheet and a pass on the type 5 indicator), so the tester must choose the right object.

A purple vial reading only means "no colour change". It is meaningful only for a vial that was processed, activated and incubated for its full reading time. The tool cannot see any of that.

Everything runs on the phone. There is no backend, no upload, no analytics, and the page's Content Security Policy blocks all network requests. Results stay in the browser until you export them.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page |
| `app.js` | Camera, region selection, calibration, log, export, capability report |
| `products.js` | The list of objects (add new ones here) |
| `colour.js` | Colour maths: sRGB → CIELAB, CIEDE2000, white-reference correction, vial classification, sheet analysis |
| `detect.js` | Automatic region: finds the striped pattern, returns its corners, straightens it |
| `tests/colour.test.js`, `tests/detect.test.js` | `node tests/colour.test.js` and `node tests/detect.test.js` check the colour maths and the automatic region |
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
6. **Position the object** inside the dashed frame of the landscape preview. Only what the preview shows is captured. Vial: about 10–15 cm away, with the liquid and the white part of the label both in view (hold the vial horizontally if it does not fit); avoid reflections on the plastic.
7. **Capture**, then select the region. For a **vial**, tap:
   - the **liquid** at the bottom of the vial. **Never the cap: the cap is always purple, so tapping it gives a false "no growth".**
   - the **white area of the label** (white reference), or *Skip white reference*.
   Make the region small enough to sit fully inside the liquid. If the result says "region not uniform", the box covers an edge, text or a reflection.

   For a **Bowie & Dick sheet** (with **Auto** ticked, the default):
   - Lay the sheet flat on a table, alone in view. Scanning starts by itself as soon as the camera is started (and again after *Refă fotografia*); **Fotografiază** starts another scan. Nothing is photographed until the conditions below are met.
   - Follow the message on the preview: *Looking for the striped pattern* → *Move back / Move closer* → *Hold the phone flatter* → *Hold still*. The outline around the pattern is yellow while waiting and green when everything is right.
   - When the whole pattern is inside the dashed frame, the phone is within 20° of flat and has been still for about half a second, the tool takes the photo, selects the pattern and shows the result. Tap **Cancel** to stop waiting.
   - The overlay shows the selected area and the areas analysed: green = OK, red = pink left, orange = lighter or fainter area, grey = not enough stripes. **Check that the blue outline follows the edge of the pattern** before saving.
   - To select by hand, tap one corner of the pattern, then the opposite corner. *Auto-select region* runs the automatic selection again. With **Auto** unticked, Capture takes the photo at once and you select by hand.

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

**Automatic region.** The photo is scanned for points that have light and dark stripes on both sides of them (a single edge such as the card border or a shadow does not count). The largest such area is outlined, a straight line is fitted to each of its four sides, and the resulting quadrilateral is straightened into an upright rectangle, which removes rotation and perspective. Faded areas *inside* the pattern stay inside the outline. If stripes have completely vanished along an *edge*, the outline shrinks and the shape no longer matches the sheet (width : height outside 1.12–1.6): a pass is then downgraded to uncertain.

**Automatic capture.** The same detection runs on the live preview about seven times a second. The photo is taken when: the pattern is found, clear of the frame edge and covers at least 15% of the frame; the phone's motion sensor reports at most 20° from flat (this assumes the sheet lies on a horizontal surface; set *use motion sensor* to 0 in section 7 otherwise); opposite sides of the outline differ by at most 30% (perspective); and the outline has been still for three checks. Phones without a motion sensor use the shape check only. Tilt, rotation, shape and whether capture and region were automatic are logged.

The selected pattern is split into a 5 × 5 grid of areas.

1. **Stripe vs paper:** in each area, the paper white is the brightest 10% of pixels. A pixel counts as stripe if it is clearly darker than the paper *of its own area*. That way a shadow or uneven light across the sheet is not mistaken for uneven darkening.
2. **Pink:** stripe pixels are colour-corrected using the sheet's paper white, then counted as pink if they have enough chroma and a magenta/pink/red hue.
3. **Per area:** pink share, median stripe darkness (relative L*, 0 = black), and stripe density.
4. Rules:
   - **Fail** if pink is left (≥ 10% of stripes overall, or ≥ 20% in any area), darkness differs clearly between areas (ΔL* ≥ 20) *and* the lightest area is no longer black (L* > 52), e.g. a lighter centre, stripes are clearly not dark, or an area has far fewer stripe pixels than the rest (stripes faded there).
   - **Pass** only if there is almost no pink (≤ 2% overall, ≤ 5% in any area), the stripes are dark (median L* ≤ 45), even the lightest area is still black (L* ≤ 52), areas differ by at most 25, and stripe density is even. Small differences between "black" and "slightly less black" areas do not block a pass.
   - Anything in between, glare, or a selection with too few stripes → **uncertain**.

**Threshold freeze (decided 2026-11-19):** the pass limits are not to be loosened further until readings from a real failed sheet (from a faulty cycle, not just an unprocessed pink sheet) have been logged and reviewed.

These starting values come from synthetic sheets and the manufacturer's colour-change scheme image. They must be checked against real processed sheets.

### Type 5 chemical indicator (three triangles)

1. The three triangles are found automatically (see below) or the tester taps the middle of each one. Each is measured separately.
2. The label paper around the triangles is found automatically and used as white reference.
3. Each triangle is *pink* (hue 316°–20° after white correction, chroma ≥ 12), *not pink* (any other readable colour, including blue and in-between violet), or *unreadable* (reflection, too dark or bright, or too grey, which usually means the tap missed the triangle).
4. Rules: any triangle not pink → **fail**; otherwise any unreadable or missing triangle → **uncertain**; all three pink → **pass**.

**Automatic reading.** As with the sheet, scanning starts when the camera starts. The live image is searched for three pale blue-to-pink fields of similar size at roughly equal distances from each other (vivid print such as a logo is ignored). The photo is taken when the three fields are found, clear of the frame edge, large enough to read, the phone is within 20° of flat (motion sensor) and still. A small box well inside each triangle is then measured. Only one indicator may be in view: with two, the tool asks for a single one. If the triangles are burnt out (overexposed) in the live image, the tool does not capture: it lowers the camera's exposure compensation where the phone exposes it, otherwise it asks the tester to shade the indicator or change the angle. Colours are judged against the white found near each spot of the image, so a brighter spot elsewhere in the frame does not disturb the search. Tapping the three triangles by hand, or *Selectează zona automat*, remain available.

Measured on the first two phone photos: pink hue 328–336°, unprocessed blue 281–284°. No partly changed strip has been read yet, so where "almost pink" sits is unknown; by decision of the project owner, everything that is not clearly pink counts as a fail.

### All objects

**A failed sample read as passed is an unsafe error.** The log flags it, and the test plan treats any occurrence as a stop signal.

Thresholds are editable in section 7, separately for each object. Change them only between sessions and record the change in the results template. Every log row stores the thresholds used.

## Adding an object

Append an entry to `products.js` (id, label, method `vial`, `sheet` or `patches`, its rules, messages, expected-result labels). Use generic labels: the repository is public, so no manufacturer or product names. A new colour scheme that is neither "one region" nor "pattern sheet" needs a new method in `colour.js`.

## Lighting options

The *Iluminare* options carry the same names as the columns of the printed session plan; the app adds a short description in brackets:

| Letter | Option in the app | Code stored in the log |
|---|---|---|
| A | Lumină rece CSSD (neon / LED alb) | `Cool fluorescent (CSSD)` |
| B | Lumină caldă (bec / LED cald) | `Warm / LED` |
| C | Lumină naturală (lângă fereastră) | `Daylight near window` |
| D | Lumină slabă (încăpere slab luminată) | `Dim` |
| G | Lanternă (lanterna telefonului pornită, lumina CSSD aprinsă) | `Phone torch` |
| – | Altă iluminare (describe it in *Observații*) | `Other` |

Columns E (tilted phone) and F (manual selection) of the plan are not lighting conditions: they are done under light A.

## Diagnostics

- **Nu s-a putut citi:** shown while the automatic scan is running. One tap records the attempt in the log as `necitit` (not read), with the last message the tool was showing, how long it had been trying, and the usual tester fields; the frame of that moment is downloaded to the phone. Such a reading counts as one of the readings planned for that sample and condition. The log summary counts them separately. `autoWaitSec` is also logged for successful automatic captures.
- **Wrong object selected:** if nothing is found for 5 seconds during automatic scanning, the tool suggests checking the selected object.
- **Salvează fotografia** downloads the captured frame to the phone, so that a failing case can be analysed. The page never uploads it. Photos show the product's printed label: **never commit them to this public repository.**

## Known limitations

- The tool cannot tell the purple cap from purple liquid. The tester must tap the liquid.
- Bowie & Dick, manual selection: the two-corner selection is an upright rectangle and is not straightened. Use it with the phone parallel to the sheet.
- Type 5 indicator, automatic reading: tuned on two real photos (dark table) and synthetic images. A pale blue, violet or pink surface under the strip can confuse the search; there is no perspective check, only the motion sensor.
- Bowie & Dick, automatic selection: tuned on synthetic images only so far. Expect one sheet in view, on a plain surface. A sheet whose stripes have vanished along a whole edge can be outlined too small; the shape check catches large cases only. Automatic selection is not available for vials yet.
- Phone cameras process colour automatically (white balance, tone mapping). That is exactly what this test measures.
- On iPhone, all browsers use Apple's WebKit engine, which is expected to expose fewer camera controls than Chrome on Android. The capability report records what is available.
- CSV uses comma separators and dot decimals. In Excel with Romanian regional settings, import via *Data → From Text/CSV* and set the delimiter to comma.
