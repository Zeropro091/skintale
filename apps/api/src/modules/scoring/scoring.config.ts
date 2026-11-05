/**
 * Scoring configuration. Every number here is a product heuristic, not a clinical
 * threshold. Bump ALGORITHM_VERSION whenever any value below changes — a checksum
 * test in scoring.test.ts enforces it.
 */

export type MetricName =
  | "hydration"
  | "oiliness"
  | "texture"
  | "pores"
  | "acne"
  | "redness";

export type ScoreLabel = "very_good" | "good" | "moderate" | "needs_attention";

export const ALGORITHM_VERSION = "score-v1.0.0";
export const CONDITION_VERSION = "cond-v1.0.0";

export const METRIC_NAMES: readonly MetricName[] = [
  "hydration",
  "oiliness",
  "texture",
  "pores",
  "acne",
  "redness",
];

export interface BandConfig {
  kind: "band";
  min: number;
  max: number;
  tolerance: number;
  calibrated: boolean;
}

export interface MonotonicConfig {
  kind: "monotonic";
  /** value at or below which the subscore is 100 */
  full: number;
  /** value at or above which the subscore is 0 */
  zero: number;
  calibrated: boolean;
}

export type MetricConfig = BandConfig | MonotonicConfig;

export interface ScoringConfig {
  weights: Record<MetricName, number>;
  metrics: Record<MetricName, MetricConfig>;
  labels: ReadonlyArray<{ id: ScoreLabel; min: number; max: number; ui: string }>;
}

export const SCORING_CONFIG: ScoringConfig = {
  weights: {
    hydration: 22,
    oiliness: 18,
    texture: 15,
    pores: 15,
    acne: 18,
    redness: 12,
  },
  metrics: {
    // TODO-CALIBRATION: unvalidated band, pending real consented scan data.
    hydration: { kind: "band", min: 45, max: 70, tolerance: 35, calibrated: false },
    // Oiliness is a balance metric: matte-and-tight scores badly too.
    oiliness: { kind: "band", min: 25, max: 55, tolerance: 40, calibrated: false },
    texture: { kind: "monotonic", full: 25, zero: 85, calibrated: false },
    pores: { kind: "monotonic", full: 25, zero: 85, calibrated: false },
    acne: { kind: "monotonic", full: 10, zero: 80, calibrated: false },
    redness: { kind: "monotonic", full: 15, zero: 80, calibrated: false },
  },
  labels: [
    { id: "very_good", min: 85, max: 100, ui: "Sangat Baik" },
    { id: "good", min: 70, max: 84, ui: "Cukup Baik" },
    { id: "moderate", min: 50, max: 69, ui: "Sedang" },
    { id: "needs_attention", min: 0, max: 49, ui: "Perlu Perhatian" },
  ],
};
