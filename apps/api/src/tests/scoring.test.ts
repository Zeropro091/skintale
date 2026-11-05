import { describe, expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  METRIC_NAMES,
  SCORING_CONFIG,
} from "../modules/scoring/scoring.config";
import {
  InvalidMetricError,
  bandScore,
  calculateSkinScore,
  labelFor,
  monotonicScore,
  validateWeights,
} from "../modules/scoring/scoring";

const IDEAL = {
  hydration: 58,
  oiliness: 40,
  texture: 20,
  pores: 20,
  acne: 5,
  redness: 10,
};

describe("weights", () => {
  it("sum to exactly 100", () => {
    const total = METRIC_NAMES.reduce((s, m) => s + SCORING_CONFIG.weights[m], 0);
    expect(total).toBe(100);
  });

  it("rejects a config that does not sum to 100", () => {
    const broken = { ...SCORING_CONFIG, weights: { ...SCORING_CONFIG.weights, acne: 99 } };
    expect(() => validateWeights(broken)).toThrow(/must sum to 100/);
  });
});

describe("bandScore", () => {
  const band = { min: 45, max: 70, tolerance: 35 };

  it("is 100 inside the band, inclusive", () => {
    expect(bandScore(45, band)).toBe(100);
    expect(bandScore(70, band)).toBe(100);
    expect(bandScore(58, band)).toBe(100);
  });

  it("decays linearly outside and clamps at 0", () => {
    expect(bandScore(10, band)).toBeCloseTo(0, 5); // 45-35 => 0
    expect(bandScore(27.5, band)).toBeCloseTo(50, 5);
    expect(bandScore(0, band)).toBe(0);
    // tolerance above max reaches 105, so 100 is still on the ramp and never negative
    expect(bandScore(100, band)).toBeCloseTo((100 * (105 - 100)) / 35, 5);
    expect(bandScore(105, band)).toBeCloseTo(0, 5);
    expect(bandScore(1000, band)).toBe(0);
  });
});

describe("monotonicScore", () => {
  it("clamps at both ends", () => {
    expect(monotonicScore(0, { full: 25, zero: 85 })).toBe(100);
    expect(monotonicScore(25, { full: 25, zero: 85 })).toBe(100);
    expect(monotonicScore(85, { full: 25, zero: 85 })).toBe(0);
    expect(monotonicScore(100, { full: 25, zero: 85 })).toBe(0);
  });

  it("is linear in between", () => {
    expect(monotonicScore(55, { full: 25, zero: 85 })).toBeCloseTo(50, 5);
  });
});

describe("oiliness is a balance metric, not 'lower is better'", () => {
  it("scores a very matte face below an ideal one", () => {
    const matte = calculateSkinScore({ ...IDEAL, oiliness: 0 });
    const ideal = calculateSkinScore({ ...IDEAL, oiliness: 40 });
    expect(matte.skinScore).toBeLessThan(ideal.skinScore);
  });

  it("scores a very oily face below an ideal one", () => {
    const oily = calculateSkinScore({ ...IDEAL, oiliness: 100 });
    const ideal = calculateSkinScore({ ...IDEAL, oiliness: 40 });
    expect(oily.skinScore).toBeLessThan(ideal.skinScore);
  });
});

describe("calculateSkinScore", () => {
  it("returns 100 for a perfectly ideal scan", () => {
    expect(calculateSkinScore(IDEAL).skinScore).toBe(100);
  });

  it("returns 0 for a maximally bad scan", () => {
    const bad = {
      hydration: 0,
      oiliness: 100,
      texture: 100,
      pores: 100,
      acne: 100,
      redness: 100,
    };
    expect(calculateSkinScore(bad).skinScore).toBe(0);
  });

  it("is deterministic", () => {
    const a = calculateSkinScore(IDEAL);
    const b = calculateSkinScore({ ...IDEAL });
    expect(a).toEqual(b);
  });

  it("returns an integer within 0..100 for 10k random inputs", () => {
    for (let i = 0; i < 10_000; i++) {
      const metrics = Object.fromEntries(METRIC_NAMES.map((m) => [m, Math.random() * 100]));
      const { skinScore } = calculateSkinScore(metrics);
      expect(Number.isInteger(skinScore)).toBe(true);
      expect(skinScore).toBeGreaterThanOrEqual(0);
      expect(skinScore).toBeLessThanOrEqual(100);
    }
  });

  it("rejects a missing metric instead of substituting a default", () => {
    const { redness, ...partial } = IDEAL;
    void redness;
    expect(() => calculateSkinScore(partial)).toThrow(InvalidMetricError);
  });

  it("rejects NaN, strings and out-of-range values", () => {
    expect(() => calculateSkinScore({ ...IDEAL, hydration: Number.NaN })).toThrow(InvalidMetricError);
    expect(() => calculateSkinScore({ ...IDEAL, hydration: "58" })).toThrow(InvalidMetricError);
    expect(() => calculateSkinScore({ ...IDEAL, hydration: 101 })).toThrow(InvalidMetricError);
    expect(() => calculateSkinScore({ ...IDEAL, hydration: -1 })).toThrow(InvalidMetricError);
    expect(() => calculateSkinScore(null)).toThrow(InvalidMetricError);
  });

  it("reports the algorithm version it ran under", () => {
    expect(calculateSkinScore(IDEAL).algorithmVersion).toBe(ALGORITHM_VERSION);
  });
});

describe("labels", () => {
  it("covers every integer score", () => {
    for (let s = 0; s <= 100; s++) {
      expect(() => labelFor(s)).not.toThrow();
    }
  });

  it("has the documented boundaries", () => {
    expect(labelFor(0).id).toBe("needs_attention");
    expect(labelFor(49).id).toBe("needs_attention");
    expect(labelFor(50).id).toBe("moderate");
    expect(labelFor(69).id).toBe("moderate");
    expect(labelFor(70).id).toBe("good");
    expect(labelFor(84).id).toBe("good");
    expect(labelFor(85).id).toBe("very_good");
    expect(labelFor(100).id).toBe("very_good");
  });

  it("has no medical wording in UI strings", () => {
    for (const label of SCORING_CONFIG.labels) {
      expect(label.ui.toLowerCase()).not.toMatch(/sehat|diagnos|sembuh|obat/);
    }
  });
});

describe("config integrity", () => {
  it("marks every metric as uncalibrated so nobody mistakes it for clinical data", () => {
    for (const metric of METRIC_NAMES) {
      expect(SCORING_CONFIG.metrics[metric].calibrated).toBe(false);
    }
  });

  it("freezes the config so a silent number change cannot slip through", () => {
    // If this fails you changed a scoring number. Decide deliberately, then update
    // both this snapshot and ALGORITHM_VERSION together.
    expect({ version: ALGORITHM_VERSION, weights: SCORING_CONFIG.weights, metrics: SCORING_CONFIG.metrics })
      .toEqual({
        version: "score-v1.0.0",
        weights: { hydration: 22, oiliness: 18, texture: 15, pores: 15, acne: 18, redness: 12 },
        metrics: {
          hydration: { kind: "band", min: 45, max: 70, tolerance: 35, calibrated: false },
          oiliness: { kind: "band", min: 25, max: 55, tolerance: 40, calibrated: false },
          texture: { kind: "monotonic", full: 25, zero: 85, calibrated: false },
          pores: { kind: "monotonic", full: 25, zero: 85, calibrated: false },
          acne: { kind: "monotonic", full: 10, zero: 80, calibrated: false },
          redness: { kind: "monotonic", full: 15, zero: 80, calibrated: false },
        },
      });
  });
});

describe("monotonicity of the whole score", () => {
  it("never improves when acne visibility gets worse", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let acne = 0; acne <= 100; acne += 5) {
      const score = calculateSkinScore({ ...IDEAL, acne }).skinScore;
      expect(score).toBeLessThanOrEqual(previous);
      previous = score;
    }
  });
});
