# FaceWish — Architecture

Blueprint v1.0 §3–§5, resolved into decisions. No repo existed before this scaffold, so the
target structure **is** the starting structure (Phase 0 audit: nothing to preserve).

## 1. Shape: modular monolith

One Node process, one Postgres, two apps in one repo. No microservices, no queue, no cache
until a real bottleneck appears. Modules have hard boundaries: a route handler may call one
module's public function, never another module's internals.

```
web (React)  ──HTTPS/cookie──▶  api (Express)
                                   ├── routes/           HTTP only: parse, authz, respond
                                   ├── modules/          business rules, no HTTP types
                                   ├── providers/        vision + LLM adapters
                                   └── db/               Drizzle schema, migrations, seed
                                          │
                                   Postgres + object storage (images)
```

Three invariants:

1. **AI proposes, code decides.** Providers return structured findings. Scoring, filtering,
   ranking and copy are deterministic TypeScript.
2. **Every rule is testable without a network call.** `modules/scoring`, `modules/safety`,
   `modules/recommendations`, `modules/ingredients`, `modules/food` import zero provider code.
3. **One source of truth per rule.** The frontend renders; it never recomputes a score.

## 2. Module layout

```
apps/api/src/
├── app.ts                  express app (testable, no listen)
├── server.ts               listen + graceful shutdown
├── config/                 env parsing + feature flags (fail fast on missing)
├── middleware/             auth, rateLimit, validate(zod), requestId, errorHandler
├── routes/                 thin controllers
├── modules/
│   ├── auth/               register, login, session
│   ├── users/              profile, membership
│   ├── preferences/        allergies, avoids, sensitivity
│   ├── skin-analysis/      orchestration: validate image → provider → validate → score → persist
│   ├── scoring/            pure functions + scoring.config.ts   ← implemented
│   ├── safety/             synonyms, exclusion rules, claim validator ← implemented
│   ├── recommendations/    product ranking                     ← implemented
│   ├── ingredients/        deterministic checker               ← implemented
│   ├── food/               category + allergy filter           ← implemented
│   ├── assistant/          context builder, prompt, output validation
│   └── favorites/
├── providers/
│   ├── vision/             interface + provider implementations
│   └── language-model/
├── db/                     schema/, migrations/, seed/
└── tests/
packages/contracts/         shared types + Zod schemas imported by web and api
```

## 3. Analysis codeflow (must match exactly)

1. `web` picks/captures image, checks type + size client-side (UX only, not security).
2. `POST /api/analyze-skin` with session cookie.
3. `middleware/auth` → `rateLimit` → `validate` (multipart).
4. `skin-analysis` re-checks magic bytes and decodes the image; rejects unreadable input
   **before** calling the provider (a rejected image costs nothing).
5. `providers/vision` returns raw model output.
6. `validateVisionOutput` (Zod) → on failure: `INVALID_PROVIDER_OUTPUT`, log the failure
   category (not the payload).
7. `calculateSkinScore(metrics)` → score, label, subscores. Throws on bad input.
8. Persist scan + image reference + `algorithmVersion` + `providerId`/`modelId`.
9. Respond. Frontend shows score **with** the limitations block, always.

Partial failure is a state, not an exception to swallow: if the provider times out the
endpoint returns `PROVIDER_UNAVAILABLE` and writes an audit event. No half-scans in history.

## 4. Provider adapters

```ts
interface VisionProvider {
  id: string;
  analyzeSkin(input: { image: Buffer; mime: string }): Promise<unknown>; // validated by caller
}
```
- Selection by env (`VISION_PROVIDER`), not by user input.
- Timeout 30 s, 1 retry only on 5xx/timeout, circuit breaker after 5 consecutive failures
  (60 s open) so an outage cannot queue up billable calls.
- API keys server-side only. Never in the bundle, never in a URL, never in logs.
- Raw request/response bodies are not persisted; only the validated snapshot is.

## 5. Data

Tables: `users`, `sessions`, `user_preferences`, `scans`, `products`, `product_ingredients`,
`foods`, `conversations`, `messages`, `favorites`, `audit_events`.

Rules:
- Every user-owned row carries `user_id`; queries filter on it (never fetch-then-check).
- `scans` stores the derived snapshot, so a later algorithm change does not rewrite history.
- Images: object storage, key is a random UUID. Never serve by original filename, never
  expose the bucket publicly; signed URLs, 15-minute TTL.
- Deletion is real deletion: row + image + derived rows, within one transaction where possible.

## 6. Config

`.env.example` is the contract: `DATABASE_URL`, `SESSION_SECRET`, `VISION_PROVIDER`,
`VISION_API_KEY`, `LLM_PROVIDER`, `LLM_API_KEY`, `STORAGE_*`, `WEB_ORIGIN`, `NODE_ENV`.
Config is parsed once at boot with Zod; missing required values crash immediately with a
readable message. `NODE_ENV !== production` may use stub providers, and the response must
then carry `providerId: "stub"` so it can never be mistaken for a real analysis.

## 7. Observability

Structured JSON logs with `requestId`, `userId` (hashed), `route`, `durationMs`, `status`.
Metrics worth having on day one: scan success rate, provider latency p50/p95,
`invalid_provider_output` count, rate-limit hits. Errors go to one sink; the provider payload
never does.

## 8. Deployment

Docker Compose for local (api, web, postgres). Production: one managed container + managed
Postgres. Migrations run as an explicit release step, never on app boot. Health check
`GET /healthz` reports `{ db: true, provider: "ok|degraded" }`.

## 9. Known limits to keep honest

- The vision provider cannot measure hydration or sebum. Labels say "estimasi visual".
- The score is an internal index. It is not comparable across algorithms or across apps.
- Product data quality is the weakest link; `ingredientEvidenceStatus` is a first-class
  field precisely so the UI can be honest about it.
- No queue means a provider outage is user-visible. Acceptable for MVP; revisit at volume.
