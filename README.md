# FaceWish (Skintale)

AI skin analysis + product/food recommendations. Blueprint v1.0 turned into a spec set, a
tested deterministic core, and a working HTTP API.

## Read this first

| File | Contents |
|---|---|
| `AGENTS.md` | Engineering contract for any coding agent working here |
| `docs/architecture.md` | Shape of the system, module boundaries, codeflow |
| `docs/scoring-spec.md` | Metric semantics, formulas, weights, failure states |
| `docs/safety-rules.md` | Allergies, exclusion order, assistant limits, copy rules |
| `docs/api-spec.md` | Endpoint contract, error codes |
| `docs/threat-model.md` | Threats → mitigations → tests |
| `docs/plan.md` | Phases, exit criteria, resolved decisions |

## Status

**P1 + P2 done, the P3/P4 server-side path live, and a working Gemini vision adapter.**
80 tests green,
`tsc --noEmit` clean, and the full journey verified over real HTTP: register → preferences →
scan → recommendations → ingredient check → delete.

Not done, and not pretending otherwise:

- **The web UI is a test console, not P5.** `apps/web/index.html` exercises every endpoint on
  one page, but there is no PWA shell, offline support, or design pass.
- **Vision provider is real, but nothing here is clinical.** `VISION_PROVIDER=gemini` calls
  Gemini 2.5 Flash with a JSON response schema and returns metric estimates, Indonesian
  findings and explicit limitations. Every number stays `calibrated: false` — it is a visual
  estimate, not dermatology. `stub` remains for tests and is refused in production.
- **Catalogue is 9 products**, below the 30–50 target in `docs/plan.md` D4. Each row needs a
  real ingredient list with `ingredientEvidenceStatus`, so it cannot be padded out cheaply.
- **Assistant never ran against a model.** With no `LLM_PROVIDER` it returns 503 by design.

```bash
npm install
npm test          # 67 tests
npm run typecheck # tsc --noEmit
npm run dev       # http://localhost:3000, seeds the catalogue on boot
```

```bash
# full journey
curl -c c.txt -X POST localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"password123"}'

curl -b c.txt -X PUT localhost:3000/api/preferences \
  -H 'Content-Type: application/json' \
  -d '{"sensitivityLevel":"high","allergyGroups":["fragrance"]}'

curl -b c.txt -F 'image=@face.png' localhost:3000/api/analyze-skin
curl -b c.txt 'localhost:3000/api/recommendations?type=product'
```

`data/facewish.db` is created on first boot (sqlite, WAL). Tests use a throwaway
`data/test-<timestamp>.db` per run, injected through `test.env` in `vitest.config.ts`.
## Test console (web UI)

`apps/web/index.html` is a single-file, no-build console served by the API at
`http://localhost:3000/`: register/login, preferences with allergen chips, photo upload,
score + six metric bars, product/food recommendations, ingredient checker, scan history and
delete, assistant with a graceful 503 notice.

End-to-end check (real Chrome, drives the actual DOM, fails on any console error):

```bash
npm run dev            # or a dedicated port: PORT=4131 node --import tsx apps/api/src/server.ts
npm run ui:test        # BASE_URL=http://localhost:4131 by default
```

Photos are never persisted — only a hash is stored, so deleting a scan really deletes every
trace of the image.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `{ ok, db, provider, nodeEnv }` |
| POST | `/api/auth/register` · `/login` · `/logout` | httpOnly cookie session, 7 days |
| GET | `/api/auth/me` | current user (401 when anonymous) |
| GET | `/api/auth/session` | always 200: `{ user }` or `{ user: null }` — UI probe |
| GET/PUT | `/api/preferences` | allergies, avoided ingredients, skin type, budget |
| POST | `/api/analyze-skin` | multipart `image`; PNG/JPEG/WebP, ≥512×512, ≤5 MB |
| GET | `/api/scans` · `/api/scans/:id` | owner-scoped |
| DELETE | `/api/scans/:id` | removes the scan and everything derived from it |
| GET | `/api/recommendations?type=product\|food` | ranks against the latest (or a given) scan |
| POST | `/api/ingredients/analyze` | ingredient-list checker |
| POST | `/api/assistant/chat` | 503 until an `LLM_PROVIDER` is configured |

## Ground rules

- The AI proposes, the code decides. No model output becomes a score without validation.
- Allergy exclusion outranks every score.
- No scan is ever reported with a fabricated or defaulted number.
