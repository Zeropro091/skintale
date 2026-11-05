import { run, get } from "./index";
import { createHash } from "node:crypto";

/**
 * Seed catalogue: small, curated, honest. Every product row carries an evidence status;
 * nothing enters the catalogue without an ingredient list.
 * Idempotent: seeds only when the table is empty.
 */

interface SeedProduct {
  name: string;
  brand: string;
  category: string;
  ingredients: string[];
  evidence: "verified" | "partial" | "unverified";
}

const PRODUCTS: SeedProduct[] = [
  { name: "Gentle Foaming Cleanser", brand: "Avène", category: "cleanser", ingredients: ["Aqua", "Glycerin", "Coco-Glucoside", "Sodium Cocoyl Glutamate"], evidence: "verified" },
  { name: "Salicylic Acid 2% Exfoliant", brand: "The Ordinary", category: "cleanser", ingredients: ["Aqua", "Salicylic Acid", "Glycerin", "Betaine"], evidence: "verified" },
  { name: "Niacinamide 10% + Zinc 1%", brand: "The Ordinary", category: "serum", ingredients: ["Aqua", "Niacinamide", "Zinc PCA", "Dimethicone"], evidence: "verified" },
  { name: "Hyaluronic Acid 2% + B5", brand: "The Ordinary", category: "serum", ingredients: ["Aqua", "Sodium Hyaluronate", "Panthenol", "Glycerin"], evidence: "verified" },
  { name: "Cica Balm", brand: "Skin1004", category: "moisturizer", ingredients: ["Centella Asiatica Extract", "Glycerin", "Ceramide NP", "Allantoin"], evidence: "verified" },
  { name: "Moisturizing Cream", brand: "CeraVe", category: "moisturizer", ingredients: ["Aqua", "Glycerin", "Ceramide NP", "Dimethicone", "Parfum"], evidence: "partial" },
  { name: "Daily Sunscreen SPF 50", brand: "Skin Aqua", category: "sunscreen", ingredients: ["Aqua", "Ethylhexyl Methoxycinnamate", "Glycerin", "Alcohol Denat"], evidence: "partial" },
  { name: "Azelaic Acid Suspension 10%", brand: "The Ordinary", category: "serum", ingredients: ["Aqua", "Azelaic Acid", "Dimethicone", "Glycerin"], evidence: "verified" },
  { name: "Herbal Glow Toner", brand: "Unknown Brand", category: "toner", ingredients: ["Aqua", "Lavender Oil", "Alcohol Denat"], evidence: "unverified" },
];

interface SeedFood {
  name: string;
  category: "acne" | "dry_skin" | "sensitive_skin";
  allergens: string[];
  complete: boolean;
  nutrients: string[];
}

const FOODS: SeedFood[] = [
  { name: "Salmon panggang", category: "acne", allergens: ["fish"], complete: true, nutrients: ["omega-3", "protein"] },
  { name: "Kacang almond", category: "dry_skin", allergens: ["tree_nut"], complete: true, nutrients: ["vitamin e"] },
  { name: "Tempe goreng", category: "acne", allergens: ["soy"], complete: true, nutrients: ["protein", "isoflavone"] },
  { name: "Yoghurt tawar", category: "acne", allergens: ["dairy"], complete: true, nutrients: ["probiotik"] },
  { name: "Avokad", category: "dry_skin", allergens: [], complete: true, nutrients: ["lemak sehat", "vitamin e"] },
  { name: "Bowl jus campuran", category: "sensitive_skin", allergens: [], complete: false, nutrients: [] },
];

export function seedCatalogue(): void {
  if (Number(get("SELECT COUNT(*) AS c FROM products")?.c) === 0) {
    for (const p of PRODUCTS) {
      run(
        "INSERT INTO products (id, name, brand, category, ingredients, ingredient_evidence_status) VALUES (?,?,?,?,?,?)",
        `p_${createHash("sha1").update(`${p.brand}:${p.name}`).digest("hex").slice(0, 10)}`,
        p.name,
        p.brand,
        p.category,
        JSON.stringify(p.ingredients),
        p.evidence,
      );
    }
  }
  if (Number(get("SELECT COUNT(*) AS c FROM foods")?.c) === 0) {
    for (const f of FOODS) {
      run(
        "INSERT INTO foods (id, name, category, allergens, allergen_data_complete, nutrients) VALUES (?,?,?,?,?,?)",
        `f_${createHash("sha1").update(f.name).digest("hex").slice(0, 10)}`,
        f.name,
        f.category,
        JSON.stringify(f.allergens),
        f.complete ? 1 : 0,
        JSON.stringify(f.nutrients),
      );
    }
  }
}

// No demo account is seeded: a user with a placeholder password hash can never sign in,
// and it squats an email address that a real person may want to register.

// `npm run seed` executes this file directly; importing it (from server.ts or tests)
// must not have side effects.
if (process.argv[1]?.endsWith("seed.ts")) {
  seedCatalogue();
  console.log(`[facewish] catalogue seeded into ${process.env.DB_PATH ?? "data/facewish.db"}`);
}
