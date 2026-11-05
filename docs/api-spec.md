# FaceWish — API Spec (MVP)

Base: `/api`. All responses JSON. All mutating and user-scoped endpoints require a session.
Derived from Blueprint v1.0 §10. This file is the contract; if code disagrees, code is wrong.

## 0. Envelope and errors

Success: the resource, directly. No `{ data: ... }` wrapper (one shape, less ambiguity).

Error:
```json
{ "error": { "code": "INVALID_IMAGE", "message": "Gambar tidak dapat dibaca.",
             "details": { "reason": "too_dark" }, "requestId": "req_..." } }
```

| code | HTTP | when |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no/invalid session |
| `FORBIDDEN` | 403 | resource belongs to another user |
| `NOT_FOUND` | 404 | unknown id |
| `VALIDATION_ERROR` | 400 | Zod failure, `details` lists fields |
| `INVALID_IMAGE` | 422 | unreadable/too large/no face |
| `RATE_LIMITED` | 429 | limit hit, `Retry-After` header |
| `PROVIDER_UNAVAILABLE` | 503 | vision/LLM provider down |
| `INVALID_PROVIDER_OUTPUT` | 502 | AI output failed schema |
| `INTERNAL` | 500 | unexpected; never leaks stack or provider payload |

`requestId` is echoed on every response and logged. Provider errors are mapped, never
forwarded raw.

## 1. Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{email, password, displayName?}` → 201, sets httpOnly cookie |
| POST | `/auth/login` | → 200 + session cookie |
| POST | `/auth/logout` | clears session |
| GET | `/auth/me` | → `{id, email, displayName, membershipStatus}` |

Passwords: argon2id (or bcrypt cost ≥ 12). Session: httpOnly, `SameSite=Lax`, `Secure` in
production, 7-day expiry, server-side invalidation on logout.

## 2. Preferences

`GET` / `PUT /preferences`
```json
{ "sensitivityLevel": "low|medium|high",
  "skinType": "normal|dry|oily|combination|sensitive|null",
  "allergyGroups": ["seafood","fragrance"],
  "avoidedIngredients": ["alcohol denat"],
  "preferredCategories": ["moisturizer"],
  "dislikedIngredients": ["silicone"] }
```
Unknown enum values → 400. Arrays deduped, max 50 entries, each ≤ 64 chars.

## 3. Scans

### POST `/analyze-skin`
multipart/form-data: `image` (jpeg/png/webp, ≤ 5 MB). Or `application/json`
`{ "imageBase64": "..." }` for the API client.

Pre-checks before spending a provider call: auth, rate limit (10/hour/user), MIME sniffed
from magic bytes (not the declared type), dimensions ≥ 512×512, decode succeeds, size cap.

200:
```json
{ "scanId": "sc_...", "status": "completed", "algorithmVersion": "score-v1.0.0",
  "scan": { "metrics": {...}, "subscores": {...}, "skinScore": 72, "scoreLabel": "good",
            "skinProfile": "...", "findings": [...], "sensitivityTags": [...],
            "limitations": ["..."], "imageQuality": { "acceptable": true, "reasons": [] } },
  "createdAt": "..." }
```
`status: "low_confidence"` returns the same object **without** `skinScore`/`scoreLabel`.

### GET `/scans` — `?limit=20&cursor=...` → `{ items: [...], nextCursor }`
### GET `/scans/:id` → full scan; 404 if not owned (not 403 — do not confirm existence)
### DELETE `/scans/:id` → 204, deletes DB row and stored image

## 4. Recommendations

`GET /recommendations?type=product|food&scanId=`
```json
{ "scanId": "sc_...", "algorithmVersion": "score-v1.0.0",
  "products": [ { "id":"p_1","name":"...","brand":"...","category":"moisturizer",
                  "matchScore": 78, "matchedIngredients": ["niacinamide"],
                  "matchReasons": ["..."], "warnings": ["..."],
                  "ingredientEvidenceStatus": "verified",
                  "excluded": false } ],
  "excluded": [ { "id":"p_9","name":"...","exclusionReason": "allergy:seafood" } ],
  "foods": [ ... ] }
```
`excluded` is returned separately so the UI can explain *why* something is missing —
silently dropping items looks like a bug and hides the safety work.

## 5. Ingredient checker

`POST /ingredients/analyze`
```json
{ "ingredientText": "Aqua, Glycerin, Niacinamide, Parfum" }
```
→
```json
{ "items": [ { "raw":"Parfum","canonical":"fragrance","status":"avoid","reasons":["allergy:fragrance"] } ],
  "summary": { "total":4, "avoid":1, "caution":0, "beneficial":2, "neutral":0, "unknown":1 },
  "verdict": "not_recommended" }
```
Deterministic, no provider call. Max 5 000 chars, max 200 ingredients.

## 6. Assistant

`POST /assistant/chat` `{ "message": "...", "conversationId"?: "..." }` → `{ reply, conversationId }`
`GET /assistant/conversations` · `GET /assistant/conversations/:id`
Input cap 2 000 chars. Context assembled server-side. Non-streaming for MVP.

## 7. Favorites

`POST /favorites` `{ "itemType":"product|food", "itemId" }` · `DELETE /favorites/:itemId`
`GET /favorites` → grouped by type.

## 8. Admin (role-gated)

`GET/POST/PATCH/DELETE /admin/products`, `/admin/foods`. Every mutation writes an audit row
(`actorId`, `action`, `entity`, `before`, `after`). `ingredientEvidenceStatus` is required on
create — a product with no ingredients cannot be `verified`.

## 9. Cross-cutting rules

- Ownership checks on every `:id` route; the query itself filters by `userId`.
- Rate limits: 10 scans/hour, 30 chats/hour, 60 reads/min per user.
- Response bodies never include internal provider payloads, model raw text, or storage keys.
- Pagination is cursor-based; no unbounded lists.
- All input validated with Zod at the boundary; typed handler after that.
- Idempotency: `POST /analyze-skin` accepts `Idempotency-Key` to avoid duplicate scans on retry.
