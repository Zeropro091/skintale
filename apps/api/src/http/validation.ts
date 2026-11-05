import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { METRIC_NAMES } from "../modules/scoring/scoring.config";
import { HttpError } from "./middleware";

export const preferencesSchema = z.object({
  sensitivityLevel: z.enum(["low", "medium", "high"]).default("medium"),
  skinType: z.enum(["normal", "dry", "oily", "combination", "sensitive"]).nullish().default(null),
  allergyGroups: z.array(z.string().min(1).max(64)).max(50).default([]),
  avoidedIngredients: z.array(z.string().min(1).max(64)).max(50).default([]),
  preferredCategories: z.array(z.string().min(1).max(64)).max(50).default([]),
  dislikedIngredients: z.array(z.string().min(1).max(64)).max(50).default([]),
});

export const registerSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(80).optional(),
});

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export const assistantSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
});

export const ingredientAnalyzeSchema = z.object({
  ingredientText: z.string().min(1).max(5000),
});

export const visionOutputSchema = z.object({
  imageQuality: z.object({ acceptable: z.boolean(), reasons: z.array(z.string()) }),
  metrics: z.object(
    Object.fromEntries(METRIC_NAMES.map((n) => [n, z.number().finite().min(0).max(100)])) as Record<
      (typeof METRIC_NAMES)[number],
      z.ZodNumber
    >,
  ),
  skinProfile: z.string().max(500),
  findings: z.array(z.string().max(300)).max(20),
  sensitivityTags: z.array(z.string().max(40)).max(10),
  limitations: z.array(z.string().max(300)).max(10),
});

export type PreferencesInput = z.infer<typeof preferencesSchema>;
export type VisionOutput = z.infer<typeof visionOutputSchema>;

/** Parses with Zod and converts failures into the documented error envelope. */
export function validate<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(
        new HttpError("VALIDATION_ERROR", "Data tidak valid.", {
          fields: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        }),
      );
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateVisionOutput(raw: unknown): VisionOutput {
  const result = visionOutputSchema.safeParse(raw);
  if (!result.success) {
    throw Object.assign(
      new Error(
        `Vision output failed schema: ${result.error.issues.map((i) => i.path.join(".")).join(", ") || "unknown"}`,
      ),
      { code: "INVALID_PROVIDER_OUTPUT" },
    );
  }
  return result.data;
}
