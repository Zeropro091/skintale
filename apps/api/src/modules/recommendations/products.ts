import { resolveIngredient, type CanonicalId } from "../safety/synonyms";
import { evaluateExclusion, type SafetyProfile } from "../safety/exclusion";
import type { Metrics } from "../scoring/scoring";

export type EvidenceStatus = "verified" | "partial" | "unverified";

export interface CatalogueProduct {
  id: string;
  name: string;
  brand: string;
  category: string;
  ingredients: string[];
  ingredientEvidenceStatus: EvidenceStatus;
}

export interface NeedRule {
  id: string;
  /** fires when every condition holds */
  when: (m: Metrics) => string[];
  ingredients: CanonicalId[];
  categoryBias: string[];
  calibrated: boolean;
}

/** TODO-CALIBRATION: product heuristics, not clinical guidance. */
export const NEED_RULES: readonly NeedRule[] = [
  {
    id: "oily_pores",
    when: (m) => (m.oiliness > 60 && m.pores > 60 ? ["oiliness", "pores"] : []),
    ingredients: ["niacinamide", "salicylic_acid", "zinc_pca"],
    categoryBias: ["cleanser"],
    calibrated: false,
  },
  {
    id: "dehydrated",
    when: (m) => (m.hydration < 55 ? ["hydration"] : []),
    ingredients: ["glycerin", "hyaluronic_acid", "ceramide", "panthenol"],
    categoryBias: ["moisturizer"],
    calibrated: false,
  },
  {
    id: "redness",
    when: (m) => (m.redness > 55 ? ["redness"] : []),
    ingredients: ["centella", "panthenol", "allantoin"],
    categoryBias: ["moisturizer", "serum"],
    calibrated: false,
  },
  {
    id: "acne",
    when: (m) => (m.acne > 55 ? ["acne"] : []),
    ingredients: ["salicylic_acid", "benzoyl_peroxide", "azelaic_acid"],
    categoryBias: ["cleanser"],
    calibrated: false,
  },
  {
    id: "texture",
    when: (m) => (m.texture > 55 ? ["texture"] : []),
    ingredients: ["glycolic_acid", "niacinamide"],
    categoryBias: ["serum"],
    calibrated: false,
  },
];

/** Ingredients that cost points when present, unless already excluded by an allergy. */
export const CAUTION_INGREDIENTS: readonly CanonicalId[] = [
  "fragrance",
  "alcohol_denat",
  "essential_oil",
  "sodium_lauryl_sulfate",
];

export interface ProductMatch {
  id: string;
  name: string;
  brand: string;
  category: string;
  matchScore: number | null;
  matchedIngredients: CanonicalId[];
  matchedNeeds: string[];
  matchReasons: string[];
  warnings: string[];
  ingredientEvidenceStatus: EvidenceStatus;
  excluded: boolean;
  exclusionReason: string | null;
}

export const BASE_SCORE = 40;
export const NEED_BONUS = 25;
export const MAX_NEED_BONUS = 50;
export const CATEGORY_BONUS = 15;
export const CAUTION_PENALTY = 8;

const clamp = (v: number) => Math.min(100, Math.max(0, v));

/**
 * Compatibility index, 0-100. Not a probability of effectiveness and never rendered
 * with a percent sign.
 */
export function evaluateProductCompatibility(input: {
  metrics: Metrics;
  profile: SafetyProfile;
  product: CatalogueProduct;
}): ProductMatch {
  const { metrics, profile, product } = input;
  const base = {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    ingredientEvidenceStatus: product.ingredientEvidenceStatus,
  };

  const exclusion = evaluateExclusion(product.ingredients, profile);
  if (exclusion.excluded) {
    return {
      ...base,
      matchScore: null,
      matchedIngredients: [],
      matchedNeeds: [],
      matchReasons: [],
      warnings: [`Dikecualikan: ${exclusion.exclusionReason}`],
      excluded: true,
      exclusionReason: exclusion.exclusionReason,
    };
  }

  const canonical = new Set(
    product.ingredients.map((i) => resolveIngredient(i)).filter((i): i is string => !!i),
  );

  const matchedNeeds: string[] = [];
  const needed = new Set<CanonicalId>();
  for (const rule of NEED_RULES) {
    const needs = rule.when(metrics);
    if (needs.length === 0) continue;
    matchedNeeds.push(...needs);
    for (const ing of rule.ingredients) needed.add(ing);
  }

  const matchedIngredients = [...canonical].filter((i) => needed.has(i));
  const needBonus = Math.min(MAX_NEED_BONUS, matchedIngredients.length * NEED_BONUS);
  const categoryBonus = matchedNeeds.length && NEED_RULES.some(
    (r) => r.when(metrics).length > 0 && r.categoryBias.includes(product.category),
  ) ? CATEGORY_BONUS : 0;

  // Penalty counts unique canonical irritants only — two synonyms must not double-dip.
  const cautionHits = [...canonical].filter(
    (i) => CAUTION_INGREDIENTS.includes(i) && (profile.sensitivityLevel !== "low" || i === "fragrance"),
  );
  const penalty = cautionHits.length * CAUTION_PENALTY;

  const matchScore = clamp(Math.round(BASE_SCORE + needBonus + categoryBonus - penalty));

  const warnings: string[] = [];
  if (cautionHits.length) warnings.push(`Mengandung bahan yang perlu diperhatikan: ${cautionHits.join(", ")}`);
  if (product.ingredientEvidenceStatus === "unverified") {
    warnings.push("Komposisi belum terverifikasi — kecocokan bahan tidak dapat dipastikan.");
  }
  if (product.ingredientEvidenceStatus === "partial") {
    warnings.push("Komposisi hanya sebagian tercatat.");
  }
  if (matchScore >= 70 && canonical.size < 3) {
    warnings.push("Data bahan terlalu sedikit untuk skor setinggi ini.");
  }

  return {
    ...base,
    matchScore,
    matchedIngredients,
    matchedNeeds: [...new Set(matchedNeeds)],
    matchReasons: matchedIngredients.map((i) => `Mengandung ${i} yang relevan untuk ${matchedNeeds.join(", ")}`),
    warnings,
    excluded: false,
    exclusionReason: null,
  };
}

export interface RankedProducts {
  products: ProductMatch[];
  excluded: ProductMatch[];
}

export function rankProducts(input: {
  metrics: Metrics;
  profile: SafetyProfile;
  products: readonly CatalogueProduct[];
}): RankedProducts {
  const all = input.products.map((product) => evaluateProductCompatibility({ ...input, product }));
  const excluded = all.filter((p) => p.excluded);
  const products = all
    .filter((p) => !p.excluded)
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0) || a.name.localeCompare(b.name));
  return { products, excluded };
}
