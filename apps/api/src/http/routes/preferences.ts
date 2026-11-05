import { Router } from "express";
import { get, run } from "../../db";
import { asyncHandler, requireAuth } from "../../http/middleware";
import { preferencesSchema, validate } from "../../http/validation";

export const preferencesRouter = Router();

preferencesRouter.get(
  "/preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = get(
      "SELECT * FROM user_preferences WHERE user_id = ?",
      req.user!.id,
    );
    if (!row) {
      res.json(preferencesSchema.parse({}));
      return;
    }
    const r = row as Record<string, string | null>;
    res.json({
      sensitivityLevel: r.sensitivity_level,
      skinType: r.skin_type,
      allergyGroups: JSON.parse(r.allergy_groups ?? "[]"),
      avoidedIngredients: JSON.parse(r.avoided_ingredients ?? "[]"),
      preferredCategories: JSON.parse(r.preferred_categories ?? "[]"),
      dislikedIngredients: JSON.parse(r.disliked_ingredients ?? "[]"),
    });
  }),
);

preferencesRouter.put(
  "/preferences",
  requireAuth,
  validate(preferencesSchema),
  asyncHandler(async (req, res) => {
    const p = req.body as {
      sensitivityLevel: string;
      skinType: string | null;
      allergyGroups: string[];
      avoidedIngredients: string[];
      preferredCategories: string[];
      dislikedIngredients: string[];
    };
    const dedupe = (arr: string[]) => [...new Set(arr.map((s) => s.trim().toLowerCase()))];
    const now = new Date().toISOString();

    run(
      `INSERT INTO user_preferences (user_id, sensitivity_level, skin_type, allergy_groups,
         avoided_ingredients, preferred_categories, disliked_ingredients, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         sensitivity_level=excluded.sensitivity_level, skin_type=excluded.skin_type,
         allergy_groups=excluded.allergy_groups, avoided_ingredients=excluded.avoided_ingredients,
         preferred_categories=excluded.preferred_categories, disliked_ingredients=excluded.disliked_ingredients,
         updated_at=excluded.updated_at`,
      req.user!.id,
      p.sensitivityLevel,
      p.skinType,
      JSON.stringify(dedupe(p.allergyGroups)),
      JSON.stringify(dedupe(p.avoidedIngredients)),
      JSON.stringify(dedupe(p.preferredCategories)),
      JSON.stringify(dedupe(p.dislikedIngredients)),
      now,
    );

    res.json({ ...p, allergyGroups: dedupe(p.allergyGroups), avoidedIngredients: dedupe(p.avoidedIngredients) });
  }),
);
