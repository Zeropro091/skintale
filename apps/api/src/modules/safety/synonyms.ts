/**
 * Canonical ingredient / allergen vocabulary. Matching goes through this file —
 * never free-text substring search, never fuzzy inference.
 */

export type CanonicalId = string;

interface SynonymEntry {
  canonical: CanonicalId;
  aliases: string[];
  /** allergy group this canonical id belongs to, if any */
  allergyGroup?: string;
  /** reassurance for maintainers: is this a cosmetic or a food term */
  domain: "cosmetic" | "food" | "both";
}

export const SYNONYMS: readonly SynonymEntry[] = [
  { canonical: "water", aliases: ["aqua", "eau", "water"], domain: "cosmetic" },
  { canonical: "fragrance", aliases: ["fragrance", "parfum", "perfume", "aroma"], allergyGroup: "fragrance", domain: "both" },
  { canonical: "niacinamide", aliases: ["niacinamide", "nicotinamide", "vitamin b3"], domain: "cosmetic" },
  { canonical: "salicylic_acid", aliases: ["salicylic acid", "bha", "beta hydroxy acid"], domain: "cosmetic" },
  { canonical: "glycolic_acid", aliases: ["glycolic acid", "aha"], domain: "cosmetic" },
  { canonical: "hyaluronic_acid", aliases: ["hyaluronic acid", "sodium hyaluronate"], domain: "cosmetic" },
  { canonical: "glycerin", aliases: ["glycerin", "glycerine", "glycerol"], domain: "cosmetic" },
  { canonical: "ceramide", aliases: ["ceramide", "ceramide np", "ceramide ap"], domain: "cosmetic" },
  { canonical: "panthenol", aliases: ["panthenol", "provitamin b5", "dexpanthenol"], domain: "cosmetic" },
  { canonical: "centella", aliases: ["centella asiatica", "cica", "madecassoside", "asiaticoside"], domain: "cosmetic" },
  { canonical: "allantoin", aliases: ["allantoin"], domain: "cosmetic" },
  { canonical: "azelaic_acid", aliases: ["azelaic acid"], domain: "cosmetic" },
  { canonical: "benzoyl_peroxide", aliases: ["benzoyl peroxide", "bpo"], domain: "cosmetic" },
  { canonical: "zinc_pca", aliases: ["zinc pca"], domain: "cosmetic" },
  { canonical: "alcohol_denat", aliases: ["alcohol denat", "denatured alcohol", "sd alcohol", "ethanol"], domain: "cosmetic" },
  { canonical: "essential_oil", aliases: ["essential oil", "lavender oil", "tea tree oil", "citrus oil"], domain: "cosmetic" },
  { canonical: "sodium_lauryl_sulfate", aliases: ["sodium lauryl sulfate", "sls"], domain: "cosmetic" },
  { canonical: "silicone", aliases: ["dimethicone", "cyclopentasiloxane", "silicone"], domain: "cosmetic" },
  { canonical: "preservative", aliases: ["phenoxyethanol", "methylparaben", "propylparaben", "preservative"], domain: "cosmetic" },

  { canonical: "shrimp", aliases: ["shrimp", "prawn", "udang"], allergyGroup: "seafood", domain: "food" },
  { canonical: "crab", aliases: ["crab", "kepiting"], allergyGroup: "seafood", domain: "food" },
  { canonical: "squid", aliases: ["squid", "cumi"], allergyGroup: "seafood", domain: "food" },
  { canonical: "shellfish", aliases: ["shellfish", "lobster", "kerang", "scallop"], allergyGroup: "seafood", domain: "food" },
  { canonical: "fish", aliases: ["fish", "ikan", "salmon", "tuna", "mackerel", "sardine"], allergyGroup: "seafood", domain: "food" },
  { canonical: "peanut", aliases: ["peanut", "kacang tanah", "groundnut", "arachis"], allergyGroup: "peanut", domain: "food" },
  { canonical: "tree_nut", aliases: ["almond", "cashew", "walnut", "hazelnut", "pistachio", "pecan", "mede"], allergyGroup: "tree_nut", domain: "food" },
  { canonical: "dairy", aliases: ["milk", "susu", "cheese", "keju", "butter", "mentega", "yoghurt", "yogurt", "whey", "casein"], allergyGroup: "dairy", domain: "food" },
  { canonical: "egg", aliases: ["egg", "telur", "albumen"], allergyGroup: "egg", domain: "food" },
  { canonical: "gluten", aliases: ["wheat", "gandum", "barley", "rye", "gluten", "flour", "terigu"], allergyGroup: "gluten", domain: "food" },
  { canonical: "soy", aliases: ["soy", "soya", "soybean", "kedelai", "tofu", "tahu", "tempeh", "tempe"], allergyGroup: "soy", domain: "food" },
  { canonical: "nickel", aliases: ["nickel", "nickel sulfate", "nikel"], allergyGroup: "nickel", domain: "both" },
  { canonical: "latex", aliases: ["latex", "rubber", "karet"], allergyGroup: "latex", domain: "both" },
];

/** Korean/marketing punctuation, parentheses and casing must never change a match. */
export function normalizeIngredient(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const byAlias = new Map<string, string>();
for (const entry of SYNONYMS) {
  byAlias.set(entry.canonical, entry.canonical);
  for (const alias of entry.aliases) byAlias.set(normalizeIngredient(alias), entry.canonical);
}

const byCanonical = new Map(SYNONYMS.map((e) => [e.canonical, e] as const));

export function resolveIngredient(raw: string): CanonicalId | null {
  const key = normalizeIngredient(raw);
  if (!key) return null;
  return byAlias.get(key) ?? null;
}

export function allergyGroupOf(canonical: CanonicalId): string | null {
  return byCanonical.get(canonical)?.allergyGroup ?? null;
}

/** Split an INCI / ingredient list into raw tokens, preserving order, dropping blanks. */
export function parseIngredientList(text: string): string[] {
  return text
    .split(/[,;\n•|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
