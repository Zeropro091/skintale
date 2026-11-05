# FaceWish — Scoring Spec

Status: **decision-complete for MVP**, except the numbers marked `TODO-CALIBRATION`.
Owner: Ari. Derived from Blueprint v1.0 §6 and §15.

## 1. What a metric means

The vision model never measures hydration or sebum. It reports a **visual estimate**
0–100 per metric. Every user-facing label must read as an estimate, not a measurement.

| Metric | Raw value means | Direction of "good" | Normalization |
|---|---|---|---|
| `hydration` | how moisturised the surface *looks* | band | `bandScore` |
| `oiliness` | how much shine/sebum is visible | band (balance, not max) | `bandScore` |
| `texture` | visible unevenness | less is better | `monotonicScore` desc |
| `pores` | visible pore prominence | less is better | `monotonicScore` desc |
| `acne` | visible breakout indicators | less is better | `monotonicScore` desc |
| `redness` | visible redness | less is better | `monotonicScore` desc |

`oiliness` is **not** "lower is better": a matte, tight-looking face scores badly too.
That is why it uses a band, not a monotonic ramp.

## 2. Normalization functions

All config lives in `apps/api/src/modules/scoring/scoring.config.ts` so it is testable
and tunable without touching formula code.

### 2.1 `bandScore(value, band)`

```
band = { min, max, tolerance }
if min <= value <= max        -> 100
if value < min                -> 100 * (1 - (min - value) / tolerance), floored at 0
if value > max                -> 100 * (1 - (value - max) / tolerance), floored at 0
```

### 2.2 `monotonicScore(value, full, zero)`

`full` = value at or below which the subscore is 100. `zero` = value at or above which
it is 0. Linear in between.

```
if value <= full -> 100
if value >= zero -> 0
else             -> 100 * (zero - value) / (zero - full)
```

### 2.3 Initial configuration

These are **product heuristics, not dermatological thresholds.** The `calibrated` flag
must stay `false` until someone validates them against real, consented scan data. The API
must surface `algorithmVersion`, and this version bumps whenever any number below changes.

| Metric | Function | Params | calibrated |
|---|---|---|---|
| hydration | band | min 45, max 70, tolerance 35 | false `TODO-CALIBRATION` |
| oiliness | band | min 25, max 55, tolerance 40 | false `TODO-CALIBRATION` |
| texture | monotonic desc | full 25, zero 85 | false `TODO-CALIBRATION` |
| pores | monotonic desc | full 25, zero 85 | false `TODO-CALIBRATION` |
| acne | monotonic desc | full 10, zero 80 | false `TODO-CALIBRATION` |
| redness | monotonic desc | full 15, zero 80 | false `TODO-CALIBRATION` |

## 3. Final score

Weights are fixed for MVP and **must sum to 100** — asserted at module load, and unit
tested. If the assertion fails the process must not start.

| Metric | Weight |
|---|---|
| hydration | 22 |
| oiliness | 18 |
| texture | 15 |
| pores | 15 |
| acne | 18 |
| redness | 12 |
| **total** | **100** |

```
S = round( Σ(w_i * q_i) / 100 )
```

`round` is `Math.round` (half up). `S` is an integer in `[0, 100]`.

## 4. Labels and boundaries

| Score | Internal label (id) | UI string (id) |
|---|---|---|
| 85–100 | `very_good` | Sangat Baik |
| 70–84 | `good` | Cukup Baik |
| 50–69 | `moderate` | Sedang |
| 0–49 | `needs_attention` | Perlu Perhatian |

Boundary rule: ranges are **inclusive on both ends**, evaluated top-down. `84.5` cannot
occur because `S` is an integer, but tests must still cover 84/85 and 69/70.

The label is an internal index only. It must never be rendered as "your skin is healthy"
or "you have a condition". Allowed framing: "Indeks FaceWish untuk scan ini".

## 5. Validity and failure

A scan result is **either** `completed` **or** one of the failure states. Never fill a
missing metric with `50` and pass it off as valid.

| Condition | Status | HTTP |
|---|---|---|
| image unreadable / too dark / no face | `invalid_image` | 422 |
| provider timeout / 5xx | `provider_unavailable` | 502 / 503 |
| provider output fails schema | `invalid_provider_output` | 502 |
| any metric missing, NaN, non-number, or outside 0–100 | `invalid_provider_output` | 502 |
| provider confidence too low to be useful | `low_confidence` | 200 with `status: "low_confidence"`, no score |
| scan ok | `completed` | 200 |

`low_confidence` returns findings + limitations and **no** `skinScore`, so the frontend
cannot accidentally render a stale or fake number. A failed request must never leave the
previous scan visible as if it were the new one.

## 6. Snapshot fields stored per scan

`algorithmVersion`, `providerId`, `modelId`, `imageQuality` (acceptable + reasons),
`metrics`, `subscores`, `skinScore`, `scoreLabel`, `skinProfile`, `findings`,
`sensitivityTags`, `limitations`, `createdAt`. Cross-scan comparison must compare
`algorithmVersion` and flag when they differ.

## 7. Acceptance criteria (unit)

1. Weights sum to exactly 100.
2. All seven subscore functions clamp to `[0, 100]` and reject non-finite input.
3. Boundary tests at 0, 49, 50, 69, 70, 84, 85, 100.
4. Missing / `NaN` / string / out-of-range metric → throws `InvalidMetricError`, never a score.
5. Score is always an integer within `[0, 100]` for 10k random valid inputs.
6. Changing any config number changes `ALGORITHM_VERSION` (guarded by a checksum test).
