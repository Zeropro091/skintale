import { allergyGroupOf, resolveIngredient, type CanonicalId } from "./synonyms";

export interface SafetyProfile {
  allergyGroups: string[];
  avoidedIngredients: string[];
  sensitivityLevel: "low" | "medium" | "high";
  dislikedIngredients?: string[];
}

export interface ExclusionHit {
  type: "allergy" | "avoided";
  group?: string;
  ingredient: CanonicalId;
  raw: string;
}

export interface ExclusionResult {
  excluded: boolean;
  exclusionReason: string | null;
  hits: ExclusionHit[];
  /** canonical ids the user's rules flagged, useful for UI explanation */
  flagged: CanonicalId[];
}

/**
 * Hard exclusion: allergy and explicit avoid rules only. Runs before any scoring.
 * An unknown ingredient is never treated as safe, but it also cannot be excluded —
 * the caller surfaces `unverified` evidence status instead.
 */
export function evaluateExclusion(
  rawIngredients: readonly string[],
  profile: SafetyProfile,
): ExclusionResult {
  const allergyGroups = new Set(profile.allergyGroups.map((g) => g.trim().toLowerCase()));
  const avoided = new Set(
    profile.avoidedIngredients.map((i) => resolveIngredient(i) ?? i.trim().toLowerCase()),
  );

  const hits: ExclusionHit[] = [];
  const seen = new Set<string>();

  for (const raw of rawIngredients) {
    const canonical = resolveIngredient(raw);
    if (!canonical) continue;

    const group = allergyGroupOf(canonical);
    if (group && allergyGroups.has(group)) {
      const key = `allergy:${group}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ type: "allergy", group, ingredient: canonical, raw });
      }
      continue;
    }
    if (avoided.has(canonical)) {
      const key = `avoided:${canonical}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ type: "avoided", ingredient: canonical, raw });
      }
    }
  }

  const first = hits[0];
  const exclusionReason = first
    ? first.type === "allergy"
      ? `allergy:${first.group}`
      : `avoided:${first.ingredient}`
    : null;

  return {
    excluded: hits.length > 0,
    exclusionReason,
    hits,
    flagged: [...new Set(hits.map((h) => h.ingredient))],
  };
}

/** Claims that must never reach a user, in any surface, in either language. */
const BANNED_CLAIM_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /menyembuhkan|mengobati|menghilangkan (jerawat|penyakit)/i, reason: "medical_cure_claim" },
  { pattern: /\b(cure|cures|cured|heal|heals|treats?|diagnose[sd]?)\b/i, reason: "medical_cure_claim" },
  { pattern: /aman untuk semua (orang|kulit)/i, reason: "blanket_safety_claim" },
  { pattern: /terbukti secara medis|clinically proven|dermatologis terbukti/i, reason: "unsubstantiated_proof" },
  { pattern: /pasti (sembuh|hilang|aman)/i, reason: "certainty_claim" },
  { pattern: /\b\d{1,3}\s?%\s?(cocok|match|akurat|aman)/i, reason: "fake_precision" },
];

export interface ClaimCheck {
  ok: boolean;
  violations: string[];
}

export function validateClaims(text: string): ClaimCheck {
  const violations: string[] = [];
  for (const rule of BANNED_CLAIM_PATTERNS) {
    if (rule.pattern.test(text)) violations.push(rule.reason);
  }
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

export const REQUIRED_LIMITATION =
  "Hasil ini adalah estimasi visual dari model, bukan pengukuran klinis dan bukan diagnosis medis.";
