import { describe, expect, it } from "vitest";
import type { Metrics } from "../modules/scoring/scoring";
import { evaluateProductCompatibility, rankProducts, type CatalogueProduct } from "../modules/recommendations/products";
import { analyzeIngredientsDeterministic } from "../modules/ingredients/checker";
import { filterFoodsByCategoryAndPreferences, type CatalogueFood } from "../modules/food/filter";
import type { SafetyProfile } from "../modules/safety/exclusion";

const oily: Metrics = { hydration: 40, oiliness: 75, texture: 30, pores: 70, acne: 20, redness: 25 };
const dry: Metrics = { hydration: 35, oiliness: 20, texture: 40, pores: 35, acne: 10, redness: 30 };
const calm: Metrics = { hydration: 60, oiliness: 40, texture: 20, pores: 20, acne: 5, redness: 10 };

const open: SafetyProfile = {
  allergyGroups: [],
  avoidedIngredients: [],
  sensitivityLevel: "medium",
};

const product = (over: Partial<CatalogueProduct>): CatalogueProduct => ({
  id: "p",
  name: "Product",
  brand: "Brand",
  category: "moisturizer",
  ingredients: ["Aqua", "Glycerin"],
  ingredientEvidenceStatus: "verified",
  ...over,
});

describe("product recommendations", () => {
  it("excludes an allergy hit even when the product would otherwise score 100", () => {
    const result = evaluateProductCompatibility({
      metrics: dry,
      profile: { ...open, allergyGroups: ["fragrance"] },
      product: product({ ingredients: ["Aqua", "Glycerin", "Hyaluronic Acid", "Ceramide", "Parfum"], category: "moisturizer" }),
    });
    expect(result.excluded).toBe(true);
    expect(result.matchScore).toBeNull();
    expect(result.exclusionReason).toBe("allergy:fragrance");
  });

  it("ranks a need-matching product above an unrelated one", () => {
    const matched = evaluateProductCompatibility({
      metrics: oily,
      profile: open,
      product: product({ ingredients: ["Aqua", "Niacinamide", "Salicylic Acid"], category: "cleanser" }),
    });
    const unrelated = evaluateProductCompatibility({
      metrics: oily,
      profile: open,
      product: product({ ingredients: ["Aqua", "Shea Butter"], category: "body cream" }),
    });
    expect(matched.matchScore!).toBeGreaterThan(unrelated.matchScore!);
    expect(matched.matchedNeeds).toContain("oiliness");
  });

  it("penalises a duplicated irritant once, not twice", () => {
    const once = evaluateProductCompatibility({
      metrics: calm,
      profile: open,
      product: product({ ingredients: ["Aqua", "Fragrance"] }),
    });
    const twice = evaluateProductCompatibility({
      metrics: calm,
      profile: open,
      product: product({ ingredients: ["Aqua", "Fragrance", "Parfum"] }),
    });
    expect(twice.matchScore).toBe(once.matchScore);
  });

  it("warns when ingredient evidence is unverified", () => {
    const result = evaluateProductCompatibility({
      metrics: calm,
      profile: open,
      product: product({ ingredientEvidenceStatus: "unverified" }),
    });
    expect(result.warnings.join(" ")).toMatch(/belum terverifikasi/);
  });

  it("keeps the score inside 0..100", () => {
    const result = evaluateProductCompatibility({
      metrics: dry,
      profile: { ...open, sensitivityLevel: "high" },
      product: product({
        ingredients: ["Aqua", "Fragrance", "Alcohol Denat", "Tea Tree Oil", "SLS", "Glycerin", "Hyaluronic Acid"],
      }),
    });
    expect(result.matchScore!).toBeGreaterThanOrEqual(0);
    expect(result.matchScore!).toBeLessThanOrEqual(100);
  });

  it("returns excluded items separately instead of silently dropping them", () => {
    const ranked = rankProducts({
      metrics: oily,
      profile: { ...open, allergyGroups: ["fragrance"] },
      products: [
        product({ id: "safe", ingredients: ["Aqua", "Niacinamide"] }),
        product({ id: "unsafe", ingredients: ["Aqua", "Parfum"] }),
      ],
    });
    expect(ranked.products.map((p) => p.id)).toEqual(["safe"]);
    expect(ranked.excluded.map((p) => p.id)).toEqual(["unsafe"]);
  });
});

describe("ingredient checker", () => {
  it("marks an allergy ingredient as avoid and blocks the verdict", () => {
    const result = analyzeIngredientsDeterministic({
      ingredientText: "Aqua, Glycerin, Parfum",
      profile: { ...open, allergyGroups: ["fragrance"] },
    });
    expect(result.items.find((i) => i.raw === "Parfum")?.status).toBe("avoid");
    expect(result.verdict).toBe("not_recommended");
  });

  it("lets avoid outrank beneficial for the same ingredient", () => {
    const result = analyzeIngredientsDeterministic({
      ingredientText: "Niacinamide",
      profile: { ...open, avoidedIngredients: ["niacinamide"] },
      metrics: oily,
    });
    expect(result.items[0]?.status).toBe("avoid");
  });

  it("reports unknown ingredients as unknown, never neutral", () => {
    const result = analyzeIngredientsDeterministic({
      ingredientText: "Aqua, Unicorn Tears",
      profile: open,
    });
    expect(result.items[1]?.status).toBe("unknown");
    expect(result.verdict).toBe("review_required");
  });

  it("counts the summary correctly", () => {
    const result = analyzeIngredientsDeterministic({
      ingredientText: "Aqua, Glycerin, Niacinamide, Parfum, Unobtainium",
      profile: open,
      metrics: dry,
    });
    expect(result.summary.total).toBe(5);
    expect(result.summary.avoid + result.summary.caution + result.summary.beneficial + result.summary.neutral + result.summary.unknown).toBe(5);
  });

  it("is deterministic across runs", () => {
    const input = { ingredientText: "Aqua, Glycerin, Parfum", profile: open, metrics: dry };
    expect(analyzeIngredientsDeterministic(input)).toEqual(analyzeIngredientsDeterministic(input));
  });
});

describe("food filter", () => {
  const foods: CatalogueFood[] = [
    { id: "f1", name: "Salmon", category: "acne", allergens: ["fish"], allergenDataComplete: true, nutrients: ["omega-3"] },
    { id: "f2", name: "Tempeh", category: "acne", allergens: ["soy"], allergenDataComplete: true, nutrients: ["protein"] },
    { id: "f3", name: "Almond", category: "dry_skin", allergens: ["tree_nut"], allergenDataComplete: true, nutrients: ["vitamin e"] },
    { id: "f4", name: "Mystery Bowl", category: "sensitive_skin", allergens: [], allergenDataComplete: false, nutrients: [] },
  ];

  it("excludes an allergen match and flags it", () => {
    const result = filterFoodsByCategoryAndPreferences({ foods, profile: { ...open, allergyGroups: ["seafood"] } });
    const salmon = result.find((f) => f.id === "f1");
    expect(salmon?.hasAllergyWarning).toBe(true);
    expect(salmon?.recommendationStatus).toBe("excluded");
    expect(result.at(-1)?.id).toBe("f1"); // excluded sorts last
  });

  it("marks incomplete allergen data as uncertain, never safe", () => {
    const result = filterFoodsByCategoryAndPreferences({
      foods,
      profile: open,
      categories: ["sensitive_skin"],
    });
    expect(result[0]?.recommendationStatus).toBe("uncertain");
  });

  it("filters by category", () => {
    const result = filterFoodsByCategoryAndPreferences({ foods, profile: open, categories: ["acne"] });
    expect(result.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("sorts recommended before uncertain before excluded", () => {
    const result = filterFoodsByCategoryAndPreferences({ foods, profile: { ...open, allergyGroups: ["soy"] } });
    const order = result.map((f) => f.recommendationStatus);
    expect(order).toEqual([...order].sort((a, b) => ({ recommended: 0, uncertain: 1, excluded: 2 } as const)[a] - ({ recommended: 0, uncertain: 1, excluded: 2 } as const)[b]));
  });
});
