# FaceWish — Implementation Plan

Derived from Blueprint v1.0 §16, with the four open decisions resolved (see §4) so a coding
agent never has to stop and ask.

## 1. Phase view

| Phase | Scope | Done when |
|---|---|---|
| P0 | Repo + docs + agent contract | `docs/` complete, `AGENTS.md` in place, spec has no open questions |
| P1 | Deterministic core | 47 tests green, typecheck clean — **DONE** |
| P2 | API skeleton | `/healthz`, auth, preferences, error envelope, rate limit; no AI yet — **DONE** |
| P3 | Vision integration | `POST /analyze-skin` end-to-end with stub + real provider, failure states covered — **DONE for `stub` only**; real adapter still blocked on D2 |
| P4 | Recommendations | Products + food endpoints wired to the core, catalogue seeded — **DONE, catalogue at 9 of the 30–50 target** |
| P5 | Web MVP | Onboarding → scan → result → recommendations → ingredient checker — **NOT STARTED** |
| P6 | Assistant | Server-side context assembly, claim validator, safe fallback — **route + validator DONE**, never exercised against a real model (returns 503 with no provider) |
| P7 | Hardening | Threat-model tests, deletion path, audit log, observability — **deletion + audit log DONE**, remaining items open |

## 2. P2 — API skeleton (next up)

1. `app.ts` + `server.ts` split; `/healthz` returns `{ db, provider }`.
2. Error envelope + `requestId` middleware; map thrown `InvalidMetricError` → 502 `INVALID_PROVIDER_OUTPUT`.
3. Postgres schema (Drizzle) for `users`, `sessions`, `user_preferences`; migration runner.
4. Auth: register/login/logout/me, argon2id, httpOnly cookie session.
5. Preferences CRUD with Zod validation.
6. Rate limiter (per user + per IP) — in-memory for MVP, documented as single-instance only.

Exit: a second account cannot read the first account's rows (integration test), and a bad
body returns `VALIDATION_ERROR` with field details.

## 3. P3 — Scan path

1. Image intake: size cap, magic bytes, dimension check before decode, EXIF strip, re-encode.
2. `VisionProvider` interface + `stub` implementation that returns fixed metrics
   (`providerId: "stub"`, refused in production).
3. Real provider adapter: 30 s timeout, one retry on 5xx only, circuit breaker at 5 failures.
4. `validateVisionOutput` with Zod → then `calculateSkinScore`.
5. Persist scan snapshot with `algorithmVersion` + `providerId` + `modelId`.
6. Tests: no face, too dark, 6 MB file, HTML-as-jpeg, provider 500, malformed provider JSON.

Exit: every row of `scoring-spec.md` §5 has a passing test that asserts the exact status code.

## 4. Decisions (were open in the blueprint)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Database | **Postgres** (Docker locally, managed in prod), Drizzle ORM | JSONB for scan snapshots, real JSON queries for catalogue, no vendor lock. SQLite would strand the first real concurrency. |
| D2 | Vision provider | **One provider behind an interface**, `stub` for dev, provider id + model id stored per scan | Choice stays reversible and cost-comparable; storing the id makes history honest when you switch. |
| D3 | Release target | **Mobile-first web PWA**, no app-store build in MVP | Camera works via `<input capture>`; avoids review cycles and native cost while the score is still uncalibrated. |
| D4 | Catalogue data | **Small curated set (30–50 products) with `ingredientEvidenceStatus` on every row** | A big scraped catalogue with bad ingredient lists is a safety risk, not a feature. Depth beats breadth here. |

D2 needs one concrete pick before P3 code lands: choose at provider-selection time based on
cost per scan and JSON-schema reliability, then write the adapter — nothing above the
adapter changes.

**D1 amendment (what was actually built):** the implementation ships a thin repository layer
over `node:sqlite` (WAL mode, same SQL, same JSON-as-TEXT columns) instead of Drizzle +
Postgres. Reason: zero setup cost for the first vertical slice, and every query lives behind
`apps/api/src/db/index.ts`, so the Postgres swap is a single-file change plus a migration
runner. This is a deliberate deviation from the decision above, not an oversight — Postgres
remains the production target.

## 5. Sequencing guardrails

- P4 does not start before P3's failure states are green. Recommendations built on a fragile
  scan path produce confident nonsense.
- P5's result screen ships **with** the limitations block. Not "later".
- P6 (assistant) last: it is the highest-risk surface for medical claims and the least
  valuable until scans and recommendations actually work.
- No payments, no membership tiers until retention is proven. Blueprint §14 is right about
  this: a paywall on an uncalibrated score is selling the wrong thing.

## 6. Definition of MVP done

A new user can: sign up → set allergies → scan a face → see a score with honest limitations
→ get products that respect their allergies → check an ingredient list → delete the scan.
No step in that chain can be skipped, faked, or silently degrade.
