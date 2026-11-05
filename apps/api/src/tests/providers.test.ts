import { describe, expect, it, vi } from "vitest";
import { geminiProvider, getVisionProvider } from "../providers/vision";

const ANSWER = {
  imageQuality: { acceptable: true, reasons: [] },
  metrics: { hydration: 60, oiliness: 30, texture: 40, pores: 25, acne: 0, redness: 10 },
  skinProfile: "seimbang",
  findings: ["pori kecil"],
  sensitivityTags: [],
  limitations: ["bukan diagnosis"],
};

function stubFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return response();
  }) as unknown as typeof fetch);
  return { calls, spy };
}

describe("gemini provider", () => {
  it("posts the documented payload and returns the parsed answer", async () => {
    const { calls, spy } = stubFetch(() =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ANSWER) }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const out = (await geminiProvider.analyzeSkin({ image: Buffer.from("fake-image"), mime: "image/jpeg" })) as {
        metrics: Record<string, number>;
      };
      expect(out.metrics.hydration).toBe(60);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("gemini-2.5-flash:generateContent");
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.generationConfig.responseMimeType).toBe("application/json");
      expect(body.contents[0].parts[1].inline_data.mime_type).toBe("image/jpeg");
      expect(body.contents[0].parts[1].inline_data.data).toBe(Buffer.from("fake-image").toString("base64"));
      expect(body.generationConfig.responseSchema.required).toContain("metrics");
    } finally {
      spy.mockRestore();
    }
  });

  it("maps a rate limit to PROVIDER_UNAVAILABLE", async () => {
    const { spy } = stubFetch(() => new Response("{}", { status: 429 }));
    try {
      await expect(
        geminiProvider.analyzeSkin({ image: Buffer.from("x"), mime: "image/jpeg" }),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    } finally {
      spy.mockRestore();
    }
  });

  it("maps a bad key to INVALID_PROVIDER_OUTPUT, not a fake score", async () => {
    const { spy } = stubFetch(() => new Response("{}", { status: 403 }));
    try {
      await expect(
        geminiProvider.analyzeSkin({ image: Buffer.from("x"), mime: "image/jpeg" }),
      ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a non-JSON answer instead of inventing numbers", async () => {
    const { spy } = stubFetch(() =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "kulitmu bagus!" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await expect(
        geminiProvider.analyzeSkin({ image: Buffer.from("x"), mime: "image/jpeg" }),
      ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    } finally {
      spy.mockRestore();
    }
  });

  it("returns the stub provider in the test environment", () => {
    expect(getVisionProvider().id).toBe("stub");
  });
});
