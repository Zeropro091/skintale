import { Router } from "express";
import { get, all, run } from "../../db";
import { HttpError, asyncHandler, rateLimit, requireAuth } from "../../http/middleware";
import { validate, ingredientAnalyzeSchema } from "../../http/validation";
import { calculateSkinScore, type Metrics } from "../../modules/scoring/scoring";
import type { SafetyProfile } from "../../modules/safety/exclusion";
import { rankProducts, type CatalogueProduct } from "../../modules/recommendations/products";
import { filterFoodsByCategoryAndPreferences, type CatalogueFood, type FoodCategory } from "../../modules/food/filter";
import { analyzeIngredientsDeterministic } from "../../modules/ingredients/checker";
import { config } from "../../config";

export const recommendationsRouter = Router();
export const ingredientsRouter = Router();

async function loadProfile(userId: string): Promise<SafetyProfile> {
  const row = get("SELECT * FROM user_preferences WHERE user_id = ?", userId) as
    | { sensitivity_level: string; allergy_groups: string; avoided_ingredients: string }
    | undefined;
  if (!row) return { allergyGroups: [], avoidedIngredients: [], sensitivityLevel: "medium" };
  return {
    sensitivityLevel: row.sensitivity_level as SafetyProfile["sensitivityLevel"],
    allergyGroups: JSON.parse(row.allergy_groups),
    avoidedIngredients: JSON.parse(row.avoided_ingredients),
  };
}

interface LoadedScan {
  id: string;
  metrics: Metrics;
}

/**
 * Loads the scan a recommendation is based on. A client-supplied id is honoured only
 * if it belongs to this user — echoing an unverified id would leak scan existence.
 */
async function loadScan(userId: string, scanId: string | null): Promise<LoadedScan | null> {
  const row = scanId
    ? get<{ id: string; metrics: string; status: string }>(
        "SELECT id, metrics, status FROM scans WHERE id = ? AND user_id = ?",
        scanId,
        userId,
      )
    : get<{ id: string; metrics: string; status: string }>(
        "SELECT id, metrics, status FROM scans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
        userId,
      );
  if (!row || row.status !== "completed") return null;
  try {
    return { id: row.id, metrics: JSON.parse(row.metrics) as Metrics };
  } catch {
    return null;
  }
}

recommendationsRouter.get(
  "/recommendations",
  rateLimit("read", config.limits.readsPerMinute, 60 * 1000),
  requireAuth,
  asyncHandler(async (req, res) => {
    const type = req.query.type === "food" ? "food" : "product";
    const profile = await loadProfile(req.user!.id);
    const requestedScanId = typeof req.query.scanId === "string" ? req.query.scanId : null;
    const scan = await loadScan(req.user!.id, requestedScanId);

    if (!scan) {
      res.json({ scanId: null, algorithmVersion: null, products: [], excluded: [], foods: [], note: "Belum ada scan valid. Lakukan analisis dulu." });
      return;
    }

    const metrics = scan.metrics;
    const scanId = scan.id;
    const score = calculateSkinScore(metrics);
    const algorithmVersion = score.algorithmVersion;

    if (type === "food") {
      const foods = all("SELECT * FROM foods");
      const catalogue: CatalogueFood[] = foods.map((f) => {
        const r = f as Record<string, string | number>;
        return {
          id: String(r.id),
          name: String(r.name),
          category: String(r.category) as FoodCategory,
          allergens: JSON.parse(String(r.allergens)),
          allergenDataComplete: Number(r.allergen_data_complete) === 1,
          nutrients: JSON.parse(String(r.nutrients)),
        };
      });
      const categories = typeof req.query.categories === "string"
        ? (req.query.categories.split(",") as FoodCategory[])
        : undefined;
      res.json({
        scanId,
        algorithmVersion,
        foods: filterFoodsByCategoryAndPreferences({ foods: catalogue, profile, categories }),
      });
      return;
    }

    const rows = all("SELECT * FROM products");
    const catalogue: CatalogueProduct[] = rows.map((p) => {
      const r = p as Record<string, string | number>;
      return {
        id: String(r.id),
        name: String(r.name),
        brand: String(r.brand),
        category: String(r.category),
        ingredients: JSON.parse(String(r.ingredients)),
        ingredientEvidenceStatus: String(r.ingredient_evidence_status) as CatalogueProduct["ingredientEvidenceStatus"],
      };
    });

    const ranked = rankProducts({ metrics, profile, products: catalogue });
    res.json({ scanId, algorithmVersion, ...ranked });
  }),
);

ingredientsRouter.post(
  "/ingredients/analyze",
  rateLimit("read", config.limits.readsPerMinute, 60 * 1000),
  requireAuth,
  validate(ingredientAnalyzeSchema),
  asyncHandler(async (req, res) => {
    const profile = await loadProfile(req.user!.id);
    const scan = await loadScan(req.user!.id, null);
    const result = analyzeIngredientsDeterministic({
      ingredientText: (req.body as { ingredientText: string }).ingredientText,
      profile,
      metrics: scan?.metrics,
    });
    if (result.summary.total > 200) {
      throw new HttpError("VALIDATION_ERROR", "Maksimal 200 bahan.", { fields: [{ path: "ingredientText", message: "too many items" }] });
    }
    res.json(result);
  }),
);

// Lightweight maintenance endpoint: run("DELETE ...") when a catalogue row is retired.
export function deleteProduct(productId: string): void {
  run("DELETE FROM products WHERE id = ?", productId);
}
