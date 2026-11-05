import {
  ALGORITHM_VERSION,
  METRIC_NAMES,
  SCORING_CONFIG,
  type MetricName,
  type ScoreLabel,
} from "./scoring.config";

export class InvalidMetricError extends Error {
  constructor(
    readonly metric: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`Invalid metric "${metric}": ${reason}`);
    this.name = "InvalidMetricError";
  }
}

export type Metrics = Record<MetricName, number>;

export interface SkinScoreResult {
  skinScore: number;
  scoreLabel: ScoreLabel;
  scoreLabelUi: string;
  subscores: Record<MetricName, number>;
  algorithmVersion: string;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

function assertMetric(metric: MetricName, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidMetricError(metric, value, "expected a finite number");
  }
  if (value < 0 || value > 100) {
    throw new InvalidMetricError(metric, value, "expected a value within 0..100");
  }
  return value;
}

/** 100 inside the band, linear decay across `tolerance` on either side, floored at 0. */
export function bandScore(value: number, cfg: { min: number; max: number; tolerance: number }): number {
  if (value >= cfg.min && value <= cfg.max) return 100;
  const distance = value < cfg.min ? cfg.min - value : value - cfg.max;
  if (cfg.tolerance <= 0) return 0;
  return clamp(100 * (1 - distance / cfg.tolerance));
}

/** 100 at or below `full`, 0 at or above `zero`, linear in between. */
export function monotonicScore(value: number, cfg: { full: number; zero: number }): number {
  if (value <= cfg.full) return 100;
  if (value >= cfg.zero) return 0;
  const span = cfg.zero - cfg.full;
  if (span <= 0) return value <= cfg.full ? 100 : 0;
  return clamp((100 * (cfg.zero - value)) / span);
}

export function subscoreFor(metric: MetricName, raw: number): number {
  const cfg = SCORING_CONFIG.metrics[metric];
  return cfg.kind === "band" ? bandScore(raw, cfg) : monotonicScore(raw, cfg);
}

export function labelFor(score: number): { id: ScoreLabel; ui: string } {
  const hit = SCORING_CONFIG.labels.find((l) => score >= l.min && score <= l.max);
  if (!hit) throw new Error(`No score label covers ${score}`);
  return { id: hit.id, ui: hit.ui };
}

export function validateWeights(config = SCORING_CONFIG): void {
  const total = METRIC_NAMES.reduce((sum, m) => sum + config.weights[m], 0);
  if (total !== 100) {
    throw new Error(`Scoring weights must sum to 100, got ${total}`);
  }
}

validateWeights();

/**
 * Deterministic skin score. Pure: same metrics in, same number out.
 * Throws on incomplete or malformed metrics — never substitutes a default.
 */
export function calculateSkinScore(input: unknown): SkinScoreResult {
  if (typeof input !== "object" || input === null) {
    throw new InvalidMetricError("metrics", input, "expected an object with all six metrics");
  }
  const metrics = input as Record<string, unknown>;
  const subscores = {} as Record<MetricName, number>;
  let weighted = 0;

  for (const metric of METRIC_NAMES) {
    const raw = assertMetric(metric, metrics[metric]);
    const q = subscoreFor(metric, raw);
    subscores[metric] = Number(q.toFixed(2));
    weighted += SCORING_CONFIG.weights[metric] * q;
  }

  const skinScore = clamp(Math.round(weighted / 100));
  const label = labelFor(skinScore);

  return {
    skinScore,
    scoreLabel: label.id,
    scoreLabelUi: label.ui,
    subscores,
    algorithmVersion: ALGORITHM_VERSION,
  };
}
