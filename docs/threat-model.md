# FaceWish — Threat Model

Blueprint v1.0 §13 and §17. Scope: MVP web app. Method: assets → threats → mitigations →
acceptance test. Every mitigation below maps to a test or a config invariant; anything that
does not is aspirational and marked so.

## 1. Assets, ranked

1. **Face photos** — biometric-adjacent, irreversible if leaked. Highest sensitivity.
2. **Health-adjacent data** — allergies, sensitivity, scan history. Regulated in spirit
   (UU PDP), even without a formal medical classification.
3. Credentials and sessions.
4. Provider API keys (money + reputational damage).
5. Catalogue integrity (a poisoned product row becomes a safety incident).

## 2. Threats and mitigations

| # | Threat | Impact | Mitigation | Test |
|---|---|---|---|---|
| T1 | IDOR: user reads another user's scan by guessing id | Photo leak | Query filters by `session.userId`; 404 not 403 | GET another user's scan → 404 |
| T2 | Public bucket / predictable image key | Mass photo leak | Random UUID keys, private bucket, 15-min signed URLs | Fetch raw key unauthenticated → 403 |
| T3 | Image uploaded as "jpg" but is an HTML/SVG payload | Stored XSS via `Content-Type` sniffing | Magic-byte check, re-encode server-side, serve with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` | Upload `.jpg` containing `<script>` → 422 |
| T4 | Decompression bomb (5 MB file, 40k×40k pixels) | OOM / DoS | Dimension cap 8000×8000 checked **before** full decode, pixel cap, 5 MB size cap | Bomb image → 422, memory flat |
| T5 | Prompt injection via catalogue text or image EXIF | Assistant leaks or misadvises | Context is data-only, system prompt wins, output validator rejects banned claims; EXIF stripped on re-encode | Product named "ignore previous instructions…" → normal reply |
| T6 | Client sends its own score/preferences to skip safety | Allergy filter bypassed | Server ignores client-supplied scores; preferences always read from DB | POST with forged `skinScore` in body → ignored |
| T7 | Rate-limit bypass by user enumeration / new accounts | Cost blowout | Per-user + per-IP limits, provider circuit breaker, daily spend cap alert | 11th scan in an hour → 429 |
| T8 | Provider key leaked in bundle or logs | Financial + account loss | Key only in server env; logging redactor drops `authorization`, `api_key`, base64 blobs | Grep built bundle for key → none |
| T9 | Session fixation / token theft via XSS | Account takeover | httpOnly + SameSite cookie, no token in localStorage, CSP with no `unsafe-inline`, escaped React output | Cookie invisible to `document.cookie` |
| T10 | Password stuffing | Account takeover | argon2id, generic login error, per-IP throttle on `/auth/login`, optional delay | 10 bad logins → 429 + same message |
| T11 | Medical claim drift in copy or AI reply | Regulatory + user harm | Banned-claim validator on assistant output; copy checklist in `safety-rules.md` §7 | Reply with "menyembuhkan" → rejected |
| T12 | Admin catalogue poisoning (wrong ingredient list) | Allergy filter silently fails | `ingredientEvidenceStatus` required, audit log on every mutation, `unverified` surfaces a badge | Edit product → audit row exists |
| T13 | Backup/export containing photos | Secondary leak | Encrypted at rest, access-controlled, retention window; images excluded from analytics export | Export job output contains no image bytes |
| T14 | Deletion that does not delete | Legal exposure | Hard delete of row + object + derived rows; documented retention after account delete | Delete account → object gone in storage |

## 3. Data handling

| Data | Store | Retention | Notes |
|---|---|---|---|
| Face photo | object storage, private | Until scan deleted or account deleted | Re-encoded; EXIF stripped |
| Scan snapshot | Postgres | Same | No raw provider payload |
| Chat messages | Postgres | 90 days rolling (MVP) | User-deletable |
| Preferences | Postgres | Account lifetime | — |
| Logs | provider sink | 30 days | No images, no base64, no keys |
| Provider requests | not persisted | — | Only `providerId`/`modelId` + latency |

Consent: explicit checkbox at first scan ("foto diproses untuk analisis dan disimpan di
riwayat; bisa dihapus kapan saja"). No scan is possible without it. This is a product
requirement, not a nice-to-have — it is also the honest thing to do with someone's face.

## 4. Security invariants (enforce in code review)

1. No `any` at a trust boundary; Zod parse at every ingress.
2. No raw SQL string concatenation.
3. No secret in client code, ever — if it starts with `VITE_`, assume it is public.
4. No provider payload in a response body.
5. Every `:id` route shows an ownership test in its test file.
6. Errors are mapped; stack traces never reach the client.
7. CSP, HSTS, `X-Frame-Options: DENY`, referrer policy set in production.
8. `npm audit` clean of high/critical at release.

## 5. Out of scope for MVP (state this, do not pretend)

- Clinical validation or regulatory clearance (BPOM/Kemenkes) — the product must not imply it.
- SOC2-style controls, pen-test report, bug bounty.
- Multi-tenant isolation beyond per-user rows.
- Fraud detection on membership (no payments in MVP).
