import { allergyGroupOf, resolveIngredient } from "../safety/synonyms";
import type { SafetyProfile } from "../safety/exclusion";

export type FoodCategory = "acne" | "dry_skin" | "sensitive_skin";
export type RecommendationStatus = "recommended" | "uncertain" | "excluded";

export interface CatalogueFood {
  id: string;
  name: string;
  category: FoodCategory;
  /** canonical ids or alias strings; empty array means "not recorded", not "none" */
  allergens: string[];
  /** whether the allergen list is complete */
  allergenDataComplete: boolean;
  nutrients: string[];
}

export interface FoodMatch {
  id: string;
  name: string;
  category: FoodCategory;
  nutrients: string[];
  hasAllergyWarning: boolean;
  recommendationStatus: RecommendationStatus;
  warning: string | null;
}

/**
 * Category + allergy filter. Incomplete allergen data is `uncertain` — never `safe`,
 * because "we did not record it" is not the same as "it is not in there".
 */
export function filterFoodsByCategoryAndPreferences(input: {
  foods: readonly CatalogueFood[];
  profile: SafetyProfile;
  categories?: readonly FoodCategory[];
}): FoodMatch[] {
  const allergyGroups = new Set(input.profile.allergyGroups.map((g) => g.toLowerCase()));
  const wanted = input.categories && input.categories.length > 0 ? new Set(input.categories) : null;

  return input.foods
    .filter((food) => !wanted || wanted.has(food.category))
    .map((food) => {
      const hitGroups = new Set<string>();
      for (const allergen of food.allergens) {
        const canonical = resolveIngredient(allergen);
        const group = canonical ? allergyGroupOf(canonical) : null;
        if (group && allergyGroups.has(group)) hitGroups.add(group);
        if (!group && allergyGroups.has(allergen.toLowerCase())) hitGroups.add(allergen.toLowerCase());
      }

      const hasAllergyWarning = hitGroups.size > 0;
      const status: RecommendationStatus = hasAllergyWarning
        ? "excluded"
        : food.allergenDataComplete
          ? "recommended"
          : "uncertain";

      return {
        id: food.id,
        name: food.name,
        category: food.category,
        nutrients: food.nutrients,
        hasAllergyWarning,
        recommendationStatus: status,
        warning: hasAllergyWarning
          ? `Mengandung alergen: ${[...hitGroups].join(", ")}`
          : food.allergenDataComplete
            ? null
            : "Data alergen belum lengkap — periksa komposisi sebelum dikonsumsi.",
      } satisfies FoodMatch;
    })
    .sort((a, b) => {
      const rank = { recommended: 0, uncertain: 1, excluded: 2 } as const;
      return rank[a.recommendationStatus] - rank[b.recommendationStatus] || a.name.localeCompare(b.name);
    });
}
