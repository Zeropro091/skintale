# AGENTS.md — FaceWish (Skintale)

Read `docs/` before touching code. Order: `architecture.md` → `scoring-spec.md` →
`safety-rules.md` → `api-spec.md` → `threat-model.md`. `docs/_blueprint-source.txt` is the
original brief — context, not contract. This repo is the contract.

## Non-negotiables

1. **AI proposes, code decides.** No language model computes or overwrites a score, a
   ranking, an exclusion, or a safety verdict. Providers return structured findings that are
   validated, then the deterministic modules decide.
2. **Modules own their rules.** `scoring/`, `safety/`, `recommendations/`, `ingredients/`,
   `food/` must stay free of network calls, Express types, and DB access. They are pure and
   unit tested. Rules are data (config tables), not scattered `if` statements.
3. **Never invent a number.** Missing / invalid metric → typed error → `invalid_provider_output`.
   No `?? 50`, no default score, no "best effort" fake value. A beautiful wrong number is the
   worst possible bug in this product.
4. **Safety runs before scoring.** Allergy and avoid-list exclusion happens first and cannot
   be overridden by any score, bonus, or recommendation.
5. **Honest copy only.** No cure, treatment, diagnosis, "clinically proven", "safe for
   everyone", or "N% match". Every scan surface shows the limitation line. Indonesian copy,
   plain words, no marketing fluff.
6. **Secrets stay server-side.** Anything prefixed `VITE_` is public. Assume it is leaked.
7. **Validate at the boundary.** Zod at every ingress (body, query, params, provider output,
   AI reply). After that, typed data only — no `any` across a boundary.
8. **Every `:id` route filters by `userId` in the query**, and has a test proving a second
   user gets 404.
9. **Tests before feature.** Write the failing test for a rule, then the rule. Do not mark a
   task done without running `npm test`.
10. **Small, reviewable commits.** One module or one endpoint per commit. Never mix a
    refactor with a behavior change.

## Working agreement

- `npm test` and `npx tsc --noEmit` must both be green before any "done" report.
- If a spec is ambiguous, write the ambiguity down in `docs/decisions.md` and pick the
  conservative option (the one that shows less confident claims to the user), then continue.
- If a number is not validated, keep `calibrated: false` and `TODO-CALIBRATION`. Do not
  quietly present a heuristic as science.
- Do not add a dependency for something 30 lines of TypeScript can do.
- Do not soften a failure into a warning. Either the scan is valid or it is not.
- When changing any scoring config value: update the frozen-config test **and**
  `ALGORITHM_VERSION`, in the same commit.

## Definition of done for a feature

- [ ] Spec section exists and matches behavior
- [ ] Unit tests for the rules, including the negative cases
- [ ] Ownership + validation tests for any route
- [ ] Failure states return the documented error code, never a fallback value
- [ ] Copy passes `validateClaims` and the banned-word list
- [ ] `npm test` + `tsc --noEmit` green
- [ ] No new secret, no `console.log` of user data

## Current state

Implemented and tested (67 tests, typecheck clean):

- **Core (pure):** scoring engine, safety vocabulary + exclusion + claim validator, product
  ranking, deterministic ingredient checker, food filter.
- **API:** Express 4 + `node:sqlite`; auth (scrypt, httpOnly cookie sessions), preferences,
  scan intake (magic-byte sniffing, ≥512×512, ≤5 MB), recommendations for products and food,
  ingredient checker, assistant route, owner-scoped reads/deletes, rate limiting, audit log.
- **Provider:** `stub` only (`VISION_PROVIDER`), refused when `NODE_ENV=production`.

Not implemented: real vision adapter (blocked on decision D2), web/PWA client, assistant
against a live model, hardening items in P7. Catalogue holds 9 of the 30–50 curated products.

Two invariants that are easy to break by accident:

- `config` and the DB handle are created at module load, so test env vars must come from
  `test.env` in `vitest.config.ts`, never from `beforeAll`.
- Every route that reads a `:id` filters by `user_id`; a missing filter is a security bug,
  not a bug report.
