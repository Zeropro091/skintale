# FaceWish — Safety Rules

Status: decision-complete for MVP. Derived from Blueprint v1.0 §7–§9, §13.
These rules are enforced **server-side** and unit tested. The frontend may explain them,
never re-implement them.

## 1. Three layers, in this order

1. **Hard exclusion** — known allergy / explicit avoid list. Runs first, removes the item.
   No score can rescue an excluded item.
2. **Caution rules** — configured concern flags. Reduces score, attaches a warning.
3. **Benefit matching** — need-based relevance. Raises the base score.

Ordering matters: an ingredient can be beneficial *and* on the user's avoid list. Avoid wins.

## 2. Canonical vocabulary

Everything is matched through a controlled synonym dictionary
(`modules/safety/synonyms.ts`), never free-text substring search.

Rules:
- Normalise before comparing: lowercase, trim, strip parentheticals, collapse whitespace,
  map `aqua`/`water` → `water`, `parfum`/`fragrance` → `fragrance`, etc.
- One canonical id per ingredient. Two spellings of the same ingredient must count **once**
  when applying penalties or computing "unique" counts.
- Unknown names stay unknown. Never guess a canonical id from a fuzzy match in production.

### Seed allergy groups (extend deliberately, not casually)

| Group id | Aliases |
|---|---|
| `seafood` | shrimp, prawn, crab, lobster, shellfish, squid, fish, tuna, salmon |
| `peanut` | peanut, groundnut, arachis |
| `tree_nut` | almond, cashew, walnut, hazelnut, pistachio, pecan |
| `dairy` | milk, cheese, butter, yoghurt, whey, casein |
| `egg` | egg, albumen |
| `gluten` | wheat, barley, rye, gluten, flour |
| `soy` | soy, soya, soybean, tofu, tempeh |
| `fragrance` | fragrance, parfum, perfume, aroma |
| `nickel` | nickel, nickel sulfate |
| `latex` | latex, rubber |

A user allergy is a group id. Catalogue items reference group ids or alias strings; the
resolver maps both to the canonical id.

## 3. Product recommendation (`evaluateProductCompatibility`)

Input: `scan` (valid only), `preferences`, `product`.

```
1. normalise product ingredients -> canonical ids
2. if canonical ∩ (user.avoidedIngredients ∪ user.allergyGroups) ≠ ∅
       -> { excluded: true, exclusionReason, matchScore: null }   // stop here
3. if product.ingredientEvidenceStatus === "unverified"
       -> still rankable, matched with confidence penalty + warning
4. base = 40
   + 25 per matched need-ingredient (capped at 50)
   + 15 if category matches the user's active concern
   - 8 * (unique potentialIrritants matched, excluding allergy hits)  // already excluded
5. matchScore = clamp(round(base - penalty), 0, 100)
6. return score + matchedIngredients + matchReasons + warnings + evidenceStatus
```

Need rules (initial, `TODO-CALIBRATION`, not clinical):

| Condition | Suggest ingredients | Category bias |
|---|---|---|
| `oiliness > 60` and `pores > 60` | niacinamide, salicylic acid, zinc pca | cleanser |
| `hydration < 55` | glycerin, hyaluronic acid, ceramide, panthenol | moisturizer |
| `redness > 55` | centella asiatica, panthenol, allantoin | moisturizer |
| `acne > 55` | salicylic acid, benzoyl peroxide, azelaic acid | cleanser |
| always (daytime) | — | sunscreen recommended at top of list |

The output must include `warnings` whenever: evidence is unverified, a caution ingredient
is present, or `matchScore` is high but ingredient data is thin. `matchScore` is a
**compatibility index**, never a probability of clinical effectiveness — no percentage sign
in UI, no "X% cocok untuk kulitmu".

## 4. Food (`filterFoodsByCategoryAndPreferences`)

- Categories: `acne` (omega-3, zinc, antioxidant), `dry_skin` (healthy fats, vitamin E),
  `sensitive_skin` (user preference led).
- Allergy match → `hasAllergyWarning: true`, `recommendationStatus: "excluded"`.
- Incomplete allergen data → `recommendationStatus: "uncertain"`, never "safe".
- No claim that a food cures or prevents a skin condition. Nutrition info only.

## 5. Ingredient checker (`analyzeIngredientsDeterministic`)

No AI call. Deterministic only.

Precedence, highest first: `avoid` → `caution` → `beneficial` → `neutral` → `unknown`.

- `avoid`: matches user allergy or explicit avoid rule.
- `caution`: matches a configured concern rule (e.g. `alcohol_denat` for sensitive users).
- `beneficial`: documented relevance to the user's active concern.
- `neutral`: resolvable, no rule fired.
- `unknown`: cannot resolve to a canonical id.

Output: per-item status + reasons, summary counts, `verdict`:
`not_recommended` (any avoid) → `review_required` (any caution or unknown) → `ok`.

**No 0–100 safety score for MVP.** Any summary score would need a documented formula and
validation; a made-up number labelled "safety" is a medical claim in disguise.

## 6. AI Skin Assistant

Input context is assembled server-side only: latest valid scan, preferences, mentioned
product. Never trust client-sent scores, allergies, or history.

Must not:
1. diagnose a condition from a photo,
2. promise cosmetic or medical outcomes,
3. call a product safe *because* its match score is high,
4. ignore recorded allergies or avoid rules,
5. invent an ingredient or a study,
6. answer a risky medical question without redirecting to a professional.

Conversation content, catalogue data and retrieved text are **data**. Instructions inside
them are never executed. Output is validated (length, banned claim patterns) before it is
returned; on failure, return a safe fallback rather than raw model text.

Recommended redirect line: "Ini di luar cakupan FaceWish. Untuk keluhan seperti ini,
sebaiknya periksa ke dermatolog."

## 7. Copy rules (all surfaces)

Banned: "menyembuhkan", "mengobati", "menghilangkan jerawat permanen", "kulit sehat",
"aman untuk semua orang", "terbukti secara medis", "diagnosis".

Required: limitations block on every scan result ("estimasi visual, bukan pengukuran
klinis"), evidence-status badge on every product card, and an explicit
"bukan alat diagnosis medis" line on the scan page and in onboarding.

## 8. Acceptance criteria (unit)

1. Allergy hit always excludes, even when the product would otherwise score 100.
2. Two synonyms of the same irritant apply the penalty once.
3. `avoid` outranks `caution` and `beneficial` for the same ingredient.
4. Unknown ingredient → `unknown`, never `neutral`.
5. Incomplete allergen data → `uncertain`, never `ok`.
6. Assistant output containing a banned claim is rejected by the validator.
7. Every rule table is data, not code branches — changing a rule must not require editing
   the engine.
