import {
  allergyGroupOf,
  parseIngredientList,
  resolveIngredient,
  type CanonicalId,
} from "../safety/synonyms";
import type { SafetyProfile } from "../safety/exclusion";
import type { Metrics } from "../scoring/scoring";

export type IngredientStatus = "avoid" | "caution" | "beneficial" | "neutral" | "unknown";
export type Verdict = "not_recommended" | "review_required" | "ok";

export interface IngredientItem {
  raw: string;
  canonical: CanonicalId | null;
  status: IngredientStatus;
  reasons: string[];
}

export interface IngredientAnalysis {
  items: IngredientItem[];
  summary: Record<"total" | IngredientStatus, number>;
  verdict: Verdict;
}

const SENSITIVE_CONCERNS: Record<string, readonly CanonicalId[]> = {
  hydration: ["glycerin", "hyaluronic_acid", "ceramide", "panthenol"],
  acne: ["salicylic_acid", "benzoyl_peroxide", "azelaic_acid", "niacinamide"],
  redness: ["centella", "panthenol", "allantoin"],
  oiliness: ["niacinamide", "zinc_pca", "salicylic_acid"],
  texture: ["glycolic_acid", "niacinamide"],
  pores: ["niacinamide", "salicylic_acid"],
};

const BASE_CAUTION: readonly CanonicalId[] = [
  "fragrance",
  "alcohol_denat",
  "essential_oil",
  "sodium_lauryl_sulfate",
];

function activeConcerns(metrics?: Metrics): string[] {
  if (!metrics) return [];
  const out: string[] = [];
  if (metrics.hydration < 55) out.push("hydration");
  if (metrics.acne > 55) out.push("acne");
  if (metrics.redness > 55) out.push("redness");
  if (metrics.oiliness > 60) out.push("oiliness");
  if (metrics.texture > 55) out.push("texture");
  if (metrics.pores > 60) out.push("pores");
  return out;
}

/** Deterministic only — no provider call, no fuzzy matching, no score. */
export function analyzeIngredientsDeterministic(input: {
  ingredientText: string;
  profile: SafetyProfile;
  metrics?: Metrics;
}): IngredientAnalysis {
  const tokens = parseIngredientList(input.ingredientText);
  const allergyGroups = new Set(input.profile.allergyGroups.map((g) => g.toLowerCase()));
  const avoided = new Set(
    input.profile.avoidedIngredients.map((i) => resolveIngredient(i) ?? i.toLowerCase()),
  );
  const concerns = activeConcerns(input.metrics);
  const beneficial = new Set(concerns.flatMap((c) => SENSITIVE_CONCERNS[c] ?? []));

  const items: IngredientItem[] = tokens.map((raw) => {
    const canonical = resolveIngredient(raw);
    if (!canonical) {
      return { raw, canonical: null, status: "unknown", reasons: ["not_in_vocabulary"] };
    }

    const group = allergyGroupOf(canonical);
    if (group && allergyGroups.has(group)) {
      return { raw, canonical, status: "avoid", reasons: [`allergy:${group}`] };
    }
    if (avoided.has(canonical)) {
      return { raw, canonical, status: "avoid", reasons: ["user_avoid_list"] };
    }
    if (BASE_CAUTION.includes(canonical) || (input.profile.sensitivityLevel === "high" && canonical === "preservative")) {
      return { raw, canonical, status: "caution", reasons: ["potential_irritant"] };
    }
    if (beneficial.has(canonical)) {
      return { raw, canonical, status: "beneficial", reasons: concerns.map((c) => `supports:${c}`) };
    }
    return { raw, canonical, status: "neutral", reasons: [] };
  });

  const summary = { total: items.length, avoid: 0, caution: 0, beneficial: 0, neutral: 0, unknown: 0 };
  for (const item of items) summary[item.status] += 1;

  const verdict: Verdict =
    summary.avoid > 0 ? "not_recommended" : summary.caution > 0 || summary.unknown > 0 ? "review_required" : "ok";

  return { items, summary, verdict };
}
