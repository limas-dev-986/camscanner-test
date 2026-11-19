# Results template: indicator colour test

Fill in one copy per **phone + browser + object type**. Keep completed copies **outside this public repository** (e.g. the internal project folder).

## 1. Session

| Field | Value |
|---|---|
| Date | |
| Object type (as selected in the tool) | |
| Tester (initials) | |
| Device label (as entered in the tool) | |
| Phone model | |
| OS + version (Android / iOS) | |
| Browser + version | |
| Engine (Blink / WebKit) | |
| Tool build (bottom of page) | |
| Thresholds changed from default? (which) | |
| Calibrated? (purple n / yellow n, with or without white reference) | |
| Exported files (names) | |

## 2. Capability report (from section 8)

| Capability | Exposed? / values |
|---|---|
| Exposure mode (manual?) | |
| Exposure time / ISO range | |
| White balance mode (manual?) | |
| Colour temperature range | |
| Focus mode (manual?) | |
| Torch | |
| ImageCapture API | |
| BarcodeDetector (QR / DataMatrix) | |

## 3. Samples used

| Sample ID | Known state | How known (e.g. incubated full time, positive control) |
|---|---|---|
| P1 | Vial: purple (no growth) | |
| Y1 | Vial: yellow (growth) | |
| B1 | B&D: uniform black (pass) | |
| F1 | B&D: pink left / uneven (fail) | |

## 4. Results per condition

Minimum 5 captures per row. Fill the counts from the exported CSV.

| Lighting | Camera mode | White ref (vial only) | Angle | Samples | Captures | Correct | Uncertain | **Unsafe (fail read as pass)** | Wrong but safe (pass read as fail) |
|---|---|---|---|---|---|---|---|---|---|
| Cool fluorescent (CSSD) | Auto | Yes | Recommended | | | | | | |
| Cool fluorescent (CSSD) | Auto | No | Recommended | | | | | | |
| Cool fluorescent (CSSD) | Locked | Yes | Recommended | | | | | | |
| Cool fluorescent (CSSD) | Auto | Yes | Tilted ~20° | | | | | | |
| Warm / LED | Auto | Yes | Recommended | | | | | | |
| Daylight near window | Auto | Yes | Recommended | | | | | | |
| Dim | Auto | Yes | Recommended | | | | | | |
| Phone torch only | Auto | Yes | Recommended | | | | | | |

## 5. Against the success criteria (TEST_PLAN.md §5)

| Criterion | Target | Result | Met? |
|---|---|---|---|
| Accuracy, pass vs fail | ≥ 98% | | |
| Unsafe errors | 0 | | |
| Repeatability (no class overlap) | | | |
| Uncertain flagged, not forced | | | |
| Works in automatic camera mode | | | |

## 6. Observations

- Lighting where readings became uncertain:
- Reflections / tapping problems:
- Anything else:
