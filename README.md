# FaceWish <sub>(Skintale)</sub>

Skin analysis you can argue with. A deterministic scoring and safety core, a vision provider
behind a swappable interface, and an HTTP API that would rather fail than invent a number.

> **Not a medical device.** Every metric is a visual estimate flagged `calibrated: false`.
> Nothing here diagnoses, promises a cure, or hides its limitations.

---

## Status at a glance

| | |
|---|---|
| Test suite | **80 passing** across 5 files (`npm test`) |
| Type check | clean (`npm run typecheck`) |
| UI check | **14 browser assertions** (`npm run ui:test`) |
| Storage | `node:sqlite` locally and in tests; Postgres is the production target |
| Vision provider | `stub` (tests) · `openai-compatible` · **Gemini 2.5 Flash** (live, verified) |
| Catalogue | 9 products / 6 foods — target is 30–50 products (D4) |

---

## What it does

1. Sign up with email + password (httpOnly cookie session).
2. Declare your skin: type, sensitivity, allergy groups, ingredients to avoid.
3. Upload a face photo. It is analysed once, in memory, and discarded — only a hash is stored,
   so deleting a scan really deletes every trace of the image.
4. Get a 0–100 skin index, six metric readings, and a plain-language summary.
5. Get products ranked against *your* scan and *your* constraints, plus food suggestions for
   your concern — each with the reason it was picked, or the reason it was excluded.
6. Paste an ingredient list and get a verdict against your allergies and avoid-list.

The point is the boring part: the same inputs always produce the same output, and every
exclusion arrives with a stated reason.

---

## Quickstart

**Requirements:** Node **22.5+** (`node:sqlite`). No Docker, no build step. Developed on Node 24.

```bash
npm install
cp .env.example .env      # set SESSION_SECRET; add VISION_API_KEY for real analysis
npm run dev               # → http://localhost:3000
```

Open the URL — a single-page test console is served by the API itself. Register, save
preferences, upload a photo, and the rest is reachable from there.

Run the checks first if you want to trust the ground you are standing on:

```bash
npm test           # 80 API + engine tests, isolated DB per run
npm run typecheck
npm run ui:test    # 14 browser checks; boots its own stub server, no setup needed
```

Without a `VISION_API_KEY` the server still boots. Set `VISION_PROVIDER=stub` and it answers
with structurally valid, meaningless numbers (metrics derived from an image hash). The stub is
refused when `NODE_ENV=production` — that part is deliberate.

---

## Configuration

Everything lives in `.env`, loaded through `--env-file-if-exists`. `.env` is gitignored.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables the stub refusal and strict cookies |
| `PORT` | `3000` | |
| `DB_PATH` | `data/facewish.db` | SQLite file; tests use `data/test-<timestamp>.db` |
| `SESSION_SECRET` | — | required in production; signs the session cookie |
| `VISION_PROVIDER` | `stub` | `gemini` · `openai-compatible` · `stub` |
| `VISION_MODEL` | `gemini-2.5-flash` | |
| `VISION_API_KEY` | — | Google AI Studio key for `gemini` |
| `VISION_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | override for a proxy |
| `VISION_TIMEOUT_MS` | `30000` | a timeout is a 503, never a partial score |
| `LLM_PROVIDER` | `none` | `none` makes the assistant return an honest 503 |
| `RATE_LIMIT_SCANS_PER_HOUR` | `10` | per user |
| `RATE_LIMIT_CHATS_PER_HOUR` | `30` | per user |
| `RATE_LIMIT_READS_PER_MINUTE` | `120` | per user |

---

## How an analysis flows

```
photo bytes
  │  magic-byte sniff (PNG/JPEG/WebP), ≥512×512, ≤5 MB
  ▼
VisionProvider.analyzeSkin()      gemini | openai-compatible | stub
  │  JSON answer, schema-constrained
  ▼
validation                        wrong shape → 502 INVALID_PROVIDER_OUTPUT
  │  six metrics, 0–100
  ▼
scoring engine                    weights → 0–100 index + band
  ▼
safety layer                      allergy > avoided > caution > benefit
  ▼
recommendations                   ranked products, exclusions with reasons, foods
```

Two decisions carry most of the weight:

- **The provider is an interface, not a vendor.** `apps/api/src/providers/vision.ts` exports
  `stubProvider`, `openAiCompatible` and `geminiProvider` behind one `VisionProvider` type.
  Swapping providers is an env change, not a code change.
- **The model only proposes numbers.** Parsing, range checks, weighting, bands and every
  exclusion are deterministic code. A malformed model answer is a 502; it never becomes a
  fallback score.

---

## Scoring

| Metric | Weight | Shape |
|---|---|---|
| Hydration | 22 | band — best between 45 and 70 |
| Oiliness | 18 | band — best between 25 and 55 (both extremes penalised) |
| Texture | 15 | monotonic — lower reading scores higher |
| Pores | 15 | monotonic — lower reading scores higher |
| Acne | 18 | monotonic — lower reading scores higher |
| Redness | 12 | monotonic — lower reading scores higher |

| Index | Label |
|---|---|
| 85–100 | Sangat Baik |
| 70–84 | Cukup Baik |
| 50–69 | Sedang |
| 0–49 | Perlu Perhatian |

Weights live in `apps/api/src/modules/scoring/scoring.config.ts` under
`ALGORITHM_VERSION = "score-v1.0.0"`, pinned by a snapshot test. Every metric is
`calibrated: false`: these curves are product heuristics, not dermatological measurements.
A scan taken in bad light returns `low_confidence` **without** a `skinScore`, which is the
honest outcome.

---

## Safety model

Applied in this order, and never outranked by a higher score:

1. **Allergy** — a declared allergen excludes the product outright.
2. **Avoided ingredients** — the avoid-list excludes it outright.
3. **Caution** — still visible, flagged, with the reason shown.
4. **Benefit** — the ranking signal, and the only rule that can be outranked.

Product claims pass a validator that rejects medical promises. A catalogue row containing one
is rejected at seed time rather than softened at render time. Details in
[`docs/safety-rules.md`](docs/safety-rules.md).

---

## API

Base path `/api`. JSON in, JSON out. Session cookie `fw_session`, httpOnly, 7 days.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | `{ ok, db, provider, nodeEnv }` |
| `POST` | `/api/auth/register` · `/login` · `/logout` | session cookie |
| `GET` | `/api/auth/me` | current user, 401 when anonymous |
| `GET` | `/api/auth/session` | always 200 — `{ user }` or `{ user: null }` |
| `GET` `PUT` | `/api/preferences` | skin type, sensitivity, allergies, avoid-list |
| `POST` | `/api/analyze-skin` | multipart `image`; PNG/JPEG/WebP, ≥512×512, ≤5 MB |
| `GET` | `/api/scans` · `/api/scans/:id` | history, owner-scoped |
| `DELETE` | `/api/scans/:id` | 204; row and everything derived from it |
| `GET` | `/api/recommendations` | `?type=product\|food&scanId=…` |
| `POST` | `/api/ingredients/analyze` | ingredient list → verdict |
| `POST` | `/api/assistant/chat` | 503 while `LLM_PROVIDER=none` |
| `GET` | `/api/assistant/conversations` | history of assistant threads |

Every error uses one envelope:

```json
{ "error": { "code": "INVALID_IMAGE", "message": "…", "details": {}, "requestId": "req_…" } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no session, or expired |
| `FORBIDDEN` | 403 | resource exists but is not yours |
| `NOT_FOUND` | 404 | missing or not owned — existence is never confirmed |
| `VALIDATION_ERROR` | 400 | bad body, query, or malformed JSON |
| `INVALID_IMAGE` | 422 | wrong type, too small, too large, corrupt |
| `RATE_LIMITED` | 429 | per-endpoint budget exhausted |
| `PROVIDER_UNAVAILABLE` | 503 | provider down, timed out, or not configured |
| `INVALID_PROVIDER_OUTPUT` | 502 | provider answered with something unusable |
| `INTERNAL` | 500 | a bug — worth an issue |

Upload limits are enforced before the image reaches the provider: 5 MB, 512×512 minimum, and
magic bytes rather than a trusted `Content-Type`.

### A full journey in curl

```bash
curl -c c.txt -X POST localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"at-least-8-chars"}'

curl -b c.txt -X PUT localhost:3000/api/preferences \
  -H 'Content-Type: application/json' \
  -d '{"sensitivityLevel":"high","skinType":"oily","allergyGroups":["fragrance"],"avoidedIngredients":[],"preferredCategories":[],"dislikedIngredients":[]}'

curl -b c.txt -F 'image=@face.jpg' localhost:3000/api/analyze-skin

curl -b c.txt 'localhost:3000/api/recommendations?type=product'
curl -b c.txt 'localhost:3000/api/recommendations?type=food'
curl -b c.txt localhost:3000/api/scans
```

Food categories are goal-based (`acne`, `dry_skin`, `sensitive_skin`), not meal-based: the
filter answers "what helps this concern", not "what is for breakfast".

Response shapes and the reasoning behind each status code are in
[`docs/api-spec.md`](docs/api-spec.md).

---

## Web test console

`apps/web/index.html` — one file, no bundler, no framework, served by Express at `/`. It
exists to exercise every endpoint by hand and by machine: auth, allergen chips, upload with
preview, score with six metric bars, both recommendation feeds, ingredient checker, scan
history with delete, and the assistant's honest 503.

```bash
npm run ui:test                                   # throwaway server on :4399, stub provider
BASE_URL=http://localhost:3000 npm run ui:test    # or point it at your own server
```

`scripts/ui-smoke.mjs` fails the run on any console error, any horizontal overflow, and any
empty card. It is the closest thing to a user this repo has.

### Exposing it for a demo

```bash
ngrok http 3000                        # prints a public https URL
BASE_URL=https://<id>.ngrok-free.dev node scripts/public-check.mjs   # same flow, through the tunnel
```

A tunnelled demo is public: anyone with the link can register and spend vision calls. Keep the
rate limits low, watch the provider quota, and stop the tunnel when the demo is over.

---

## Project layout

```
apps/
  api/src/
    app.ts               express app: static web, error envelope, JSON 404
    server.ts            boot: seed catalogue, listen
    config.ts            env parsing, production guards
    db/                  schema, thin repository, seed (9 products / 6 foods)
    http/                middleware, validation, routes/
    modules/
      scoring/           weights, bands, engine
      safety/            vocabulary, exclusion order, claim validator
      recommendations/   product ranking
      ingredients/       deterministic ingredient checker
      food/              goal-based food filter
    providers/vision.ts  VisionProvider interface + stub / openai-compatible / gemini
  web/index.html         test console, no build step
docs/                    architecture, scoring, safety, API, threat model, plan
scripts/                 ui-smoke, provider probe, db inspectors
```

Business modules import no HTTP and no database code. That is what makes scoring and safety
testable without a server, and what keeps a provider swap from touching them.

---

## Tests

| Command | Covers |
|---|---|
| `npm test` | 80 tests: scoring snapshots, safety order, ranking, ingredient checker, HTTP contract, Gemini adapter (stubbed `fetch`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run ui:test` | 14 browser assertions over the full journey |
| `npm run db:inspect` | users, scans, catalogue counts from the local DB |

Test env is injected through `test.env` in `vitest.config.ts`, not `beforeAll`, because
`config.ts` and the DB handle are created at module load. Each run gets its own
`data/test-<timestamp>.db`. The Gemini adapter is tested against a stubbed `fetch`, so the
suite never touches the network.

---

## Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Database | Postgres + Drizzle is the production target; `node:sqlite` behind a thin repository keeps local dev and tests fast. Swapping is a single-file change. |
| D2 | Vision provider | **Gemini 2.5 Flash via Google AI Studio**, schema-constrained JSON, `providerId` and `modelId` stored per scan. Closed. |
| D3 | Release shape | Mobile-first web PWA, not app stores. |
| D4 | Catalogue | Hand-curated 30–50 products, each with an ingredient list and `ingredientEvidenceStatus`. Not padded with scraped data. |

---

## Status and roadmap

**Working end to end:** authentication, preferences, scan intake, Gemini vision analysis,
deterministic scoring, safety exclusions, product and food recommendations, ingredient
checker, history and deletion, rate limiting, audit log, test console.

**Not done, and not pretended otherwise:**

- **P5 is not built.** The console is a test harness: no PWA shell, no offline support, no
  design pass.
- **Catalogue is 9 products** against a 30–50 target. Every row needs a real ingredient list,
  so this cannot be padded cheaply.
- **The assistant has never run against a model.** With `LLM_PROVIDER=none` it returns 503.
- **Scoring is uncalibrated.** The curves are heuristics with a version and a snapshot test —
  that makes them stable, not correct.
- **Postgres migration and P7 hardening are pending.** See [`docs/plan.md`](docs/plan.md).

**Next, in the order that unblocks the most:** curate the catalogue to 30–50 products, then
the P5 design pass, then a real assistant model behind the existing provider pattern.

---

## Documentation

| File | Contents |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Engineering contract: non-negotiables, invariants, current state |
| [`docs/architecture.md`](docs/architecture.md) | Module boundaries and the analysis codeflow |
| [`docs/scoring-spec.md`](docs/scoring-spec.md) | Metric semantics, curves, failure states |
| [`docs/safety-rules.md`](docs/safety-rules.md) | Exclusion order, claim rules, copy rules |
| [`docs/api-spec.md`](docs/api-spec.md) | Endpoint contracts and error codes |
| [`docs/threat-model.md`](docs/threat-model.md) | 14 threats → mitigation → test |
| [`docs/plan.md`](docs/plan.md) | Phases P0–P7, decisions, amendments |

---

## Privacy

Photos are analysed in memory and discarded. The database keeps a hash, the quality verdict,
and the resulting metrics — never the image, so deleting a scan leaves no image behind.
Sessions are httpOnly cookies; passwords are scrypt hashes.

## License

Public source, all rights reserved. Read it, learn from it, open issues about it — but do not
redistribute or ship it as your own without permission.
