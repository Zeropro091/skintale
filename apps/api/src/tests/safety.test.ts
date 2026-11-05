import { describe, expect, it } from "vitest";
import { evaluateExclusion, validateClaims, type SafetyProfile } from "../modules/safety/exclusion";
import { normalizeIngredient, parseIngredientList, resolveIngredient } from "../modules/safety/synonyms";

const profile = (over: Partial<SafetyProfile> = {}): SafetyProfile => ({
  allergyGroups: [],
  avoidedIngredients: [],
  sensitivityLevel: "medium",
  ...over,
});

describe("normalisation", () => {
  it("ignores case, punctuation and parentheses", () => {
    expect(resolveIngredient("Parfum (Fragrance)")).toBe("fragrance");
    expect(resolveIngredient("  SODIUM   HYALURONATE ")).toBe("hyaluronic_acid");
    expect(normalizeIngredient("Aqua/Water/Eau")).toBe("aqua water eau");
  });

  it("maps synonyms of the same substance to one canonical id", () => {
    expect(resolveIngredient("parfum")).toBe(resolveIngredient("fragrance"));
    expect(resolveIngredient("udang")).toBe(resolveIngredient("shrimp"));
    expect(resolveIngredient("tempe")).toBe(resolveIngredient("soy"));
  });

  it("returns null for anything outside the vocabulary", () => {
    expect(resolveIngredient("unicorn tears")).toBeNull();
    expect(resolveIngredient("   ")).toBeNull();
  });

  it("splits a real INCI list", () => {
    expect(parseIngredientList("Aqua, Glycerin; Niacinamide\nParfum")).toEqual([
      "Aqua",
      "Glycerin",
      "Niacinamide",
      "Parfum",
    ]);
  });
});

describe("hard exclusion", () => {
  it("always excludes on an allergy hit", () => {
    const result = evaluateExclusion(["Aqua", "Parfum", "Glycerin"], profile({ allergyGroups: ["fragrance"] }));
    expect(result.excluded).toBe(true);
    expect(result.exclusionReason).toBe("allergy:fragrance");
    expect(result.hits[0]?.type).toBe("allergy");
  });

  it("excludes on the user's explicit avoid list", () => {
    const result = evaluateExclusion(["Aqua", "Alcohol Denat"], profile({ avoidedIngredients: ["denatured alcohol"] }));
    expect(result.excluded).toBe(true);
    expect(result.exclusionReason).toBe("avoided:alcohol_denat");
  });

  it("counts a duplicated irritant once", () => {
    const result = evaluateExclusion(["Parfum", "Fragrance"], profile({ allergyGroups: ["fragrance"] }));
    expect(result.hits).toHaveLength(1);
  });

  it("does not exclude an unrelated product", () => {
    const result = evaluateExclusion(["Aqua", "Glycerin", "Niacinamide"], profile({ allergyGroups: ["seafood"] }));
    expect(result.excluded).toBe(false);
    expect(result.exclusionReason).toBeNull();
  });

  it("never guesses on unknown ingredients", () => {
    const result = evaluateExclusion(["Unicorn Tears"], profile({ allergyGroups: ["fragrance"] }));
    expect(result.excluded).toBe(false);
    expect(result.flagged).toEqual([]);
  });
});

describe("claim validator", () => {
  it("rejects cure claims in Indonesian and English", () => {
    expect(validateClaims("Produk ini menyembuhkan jerawat").ok).toBe(false);
    expect(validateClaims("This cream cures acne").ok).toBe(false);
    expect(validateClaims("Aman untuk semua orang").ok).toBe(false);
    expect(validateClaims("Terbukti secara medis").ok).toBe(false);
    expect(validateClaims("87% cocok untuk kulitmu").ok).toBe(false);
  });

  it("allows honest hedged copy", () => {
    expect(validateClaims("Hasil ini estimasi visual, bukan diagnosis medis.").ok).toBe(true);
    expect(validateClaims("Mengandung niacinamide yang relevan untuk kulit berminyak.").ok).toBe(true);
  });
});
