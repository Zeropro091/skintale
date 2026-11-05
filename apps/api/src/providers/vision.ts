import { createHash } from "node:crypto";
import { config } from "../config";
import type { MetricName } from "../modules/scoring/scoring.config";

export interface VisionInput {
  image: Buffer;
  mime: string;
}

export interface VisionProvider {
  id: string;
  model: string;
  /** Returns raw provider output. The caller validates it — never trusts it. */
  analyzeSkin(input: VisionInput): Promise<unknown>;
}

/**
 * Deterministic stand-in for a vision model: same image bytes -> same metrics.
 * Lets the whole product be built and tested without a provider key.
 * Refused in production by config.ts, and every response is tagged providerId "stub".
 */
const stubProvider: VisionProvider = {
  id: "stub",
  model: "stub-deterministic-v1",
  async analyzeSkin({ image }: VisionInput) {
    const digest = createHash("sha256").update(image).digest();
    const metrics = {} as Record<MetricName, number>;
    const names: MetricName[] = ["hydration", "oiliness", "texture", "pores", "acne", "redness"];
    names.forEach((name, i) => {
      // Map the hash byte (0-255) into the valid 0-100 metric range; a raw byte
      // would exceed 100 and fail output validation downstream.
      metrics[name] = Math.round(((digest[i] ?? 128) / 255) * 100);
    });
    const worst = (Object.entries(metrics) as [MetricName, number][]).sort((a, b) => b[1] - a[1])[0];
    const best = (Object.entries(metrics) as [MetricName, number][]).sort((a, b) => a[1] - b[1])[0];

    return {
      imageQuality: { acceptable: true, reasons: [] },
      metrics,
      skinProfile:
        metrics.oiliness > 60
          ? "Kulit cenderung berminyak dengan pori terlihat."
          : metrics.hydration < 45
            ? "Kulit cenderung kering dan kurang lembap."
            : "Kulit relatif seimbang.",
      findings: [
        `Area paling menonjol: ${worst[0]} (estimasi ${Math.round(worst[1])}/100).`,
        `Area paling tenang: ${best[0]} (estimasi ${Math.round(best[1])}/100).`,
      ],
      sensitivityTags: metrics.redness > 55 ? ["redness"] : [],
      limitations: [
        "Analisis stub: angka diturunkan dari hash gambar, bukan dari model visi.",
        "Hasil ini bukan estimasi klinis.",
      ],
    };
  },
};

const METRIC_PROMPT = `You analyse a selfie and return ONE JSON object, no prose, no markdown.

Schema:
{
  "imageQuality": { "acceptable": boolean, "reasons": string[] },
  "metrics": { "hydration": number, "oiliness": number, "texture": number,
               "pores": number, "acne": number, "redness": number },
  "skinProfile": string,
  "findings": string[],
  "sensitivityTags": string[],
  "limitations": string[]
}

Rules:
- Every metric is an integer 0-100 describing how VISIBLE the feature is (0 = none,
  100 = maximum). Hydration is how moisturised the surface looks.
- If the image has no clear face, is too dark, or is not a person: set
  imageQuality.acceptable = false, explain in reasons, and still return the rest.
- Write skinProfile, findings and limitations in Indonesian.
- Never diagnose, never name a disease, never promise an outcome.
- limitations must state that this is a visual estimate, not a clinical measurement.`;

const openAiCompatible: VisionProvider = {
  id: "openai-compatible",
  model: config.vision.model,
  async analyzeSkin({ image, mime }: VisionInput) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.vision.timeoutMs);
    try {
      const response = await fetch(`${config.vision.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.vision.apiKey}`,
        },
        body: JSON.stringify({
          model: config.vision.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: METRIC_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: "Analyse this face image." },
                { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        const code = response.status >= 500 ? "PROVIDER_UNAVAILABLE" : "INVALID_PROVIDER_OUTPUT";
        throw Object.assign(new Error(`Vision provider HTTP ${response.status}`), { code });
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw Object.assign(new Error("Vision provider returned no content"), { code: "INVALID_PROVIDER_OUTPUT" });
      return JSON.parse(content);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw Object.assign(new Error("Vision provider timed out"), { code: "PROVIDER_UNAVAILABLE" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
};

const GEMINI_SCHEMA = {
  type: "object",
  properties: {
    imageQuality: {
      type: "object",
      properties: {
        acceptable: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } },
      },
      required: ["acceptable", "reasons"],
    },
    metrics: {
      type: "object",
      properties: {
        hydration: { type: "integer" },
        oiliness: { type: "integer" },
        texture: { type: "integer" },
        pores: { type: "integer" },
        acne: { type: "integer" },
        redness: { type: "integer" },
      },
      required: ["hydration", "oiliness", "texture", "pores", "acne", "redness"],
    },
    skinProfile: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    sensitivityTags: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
  },
  required: ["imageQuality", "metrics", "skinProfile", "findings", "sensitivityTags", "limitations"],
};

/**
 * Google AI Studio (Gemini) vision provider. Returns raw provider text as JSON; the caller
 * validates the shape, and a malformed answer is a 502 rather than a downgraded score.
 */
export const geminiProvider: VisionProvider = {
  id: "gemini",
  model: config.vision.model,
  async analyzeSkin({ image, mime }: VisionInput) {
    if (!config.vision.apiKey) {
      throw Object.assign(new Error("GEMINI_API_KEY belum diset"), { code: "PROVIDER_UNAVAILABLE" });
    }
    const model = config.vision.model.replace(/^models\//, "");
    const url = `${config.vision.baseUrl.replace(/\/$/, "")}/models/${model}:generateContent?key=${encodeURIComponent(config.vision.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.vision.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: METRIC_PROMPT }] },
          contents: [
            {
              role: "user",
              parts: [
                { text: "Analisis gambar wajah ini." },
                { inline_data: { mime_type: mime, data: image.toString("base64") } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: GEMINI_SCHEMA,
          },
        }),
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw Object.assign(new Error(`Gemini HTTP ${response.status}`), {
          code: retryable ? "PROVIDER_UNAVAILABLE" : "INVALID_PROVIDER_OUTPUT",
        });
      }

      const body = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      if (!text) {
        throw Object.assign(new Error("Gemini mengembalikan jawaban kosong"), { code: "INVALID_PROVIDER_OUTPUT" });
      }
      try {
        return JSON.parse(text);
      } catch {
        // A non-JSON answer is a provider fault, never a reason to invent numbers.
        throw Object.assign(new Error("Jawaban provider bukan JSON"), { code: "INVALID_PROVIDER_OUTPUT" });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw Object.assign(new Error("Vision provider timed out"), { code: "PROVIDER_UNAVAILABLE" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
};

export function getVisionProvider(): VisionProvider {
  if (config.vision.provider === "gemini") return geminiProvider;
  return config.vision.provider === "openai-compatible" ? openAiCompatible : stubProvider;
}
