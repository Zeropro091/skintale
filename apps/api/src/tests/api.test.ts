/**
 * Integration tests: the app is driven end-to-end over HTTP with a real sqlite file.
 * Covers ownership, auth, validation, upload validation, rate limiting, and the
 * deterministic recommendation surfaces. Provider is always "stub" here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { Express } from "express";
import { rmSync, existsSync } from "node:fs";
import { resetRateLimits } from "../http/middleware";
import { closeDb } from "../db/index";
import { config } from "../config";
import { seedCatalogue } from "../db/seed";
import { createApp } from "../app";

// Single source of truth: the DB path comes from config, which vitest.config.ts
// populates via `test.env` before any module evaluation.
const TEST_DB = config.dbPath;

let app: Express;
let agent: ReturnType<typeof supertest.agent>;

function minimalPng(width = 600, height = 600): Buffer {
  // Structurally valid PNG header with the requested dimensions. The stub provider
  // derives metrics from the hash, so the payload after IHDR does not need to decode.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.from([0, 0, 0, 13]);
  const ihdrType = Buffer.from("IHDR");
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  const rest = Buffer.from([8, 6, 0, 0, 0]); // bit depth, colour, compression, filter, interlace
  const crc = Buffer.from([0, 0, 0, 0]);
  const idat = Buffer.from("IDAT", "ascii");
  const idatLength = Buffer.from([0, 0, 0, 4]);
  const idatData = Buffer.from([1, 2, 3, 4]);
  const iend = Buffer.from("IEND", "ascii");
  return Buffer.concat([signature, ihdrLength, ihdrType, dims, rest, crc, idatLength, idat, idatData, iend]);
}

beforeAll(async () => {
  // env is already injected by vitest.config.ts (test.env) before module evaluation;
  // config.dbPath therefore already points at the per-run test file.
  // A stale file from a crashed run is tolerated: seedCatalogue + CREATE IF NOT EXISTS
  // recover, and a fresh timestamped path is used on every invocation anyway.
  try {
    if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
  } catch {
    // locked by another process; continue with the existing file
  }
  seedCatalogue();
  app = createApp();
  agent = supertest.agent(app);
});

afterAll(() => {
  // Release the sqlite handle first, or Windows refuses to unlink the files.
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix, { force: true });
    } catch {
      // tolerate: the next run uses a fresh timestamped file anyway
    }
  }
});

beforeEach(() => {
  resetRateLimits();
});

describe("healthz", () => {
  it("reports db and provider", async () => {
    const r = await agent.get("/healthz");
    expect(r.status).toBe(200);
    expect(r.body.db).toBe(true);
    expect(r.body.provider).toBe("stub");
  });
});

describe("auth", () => {
  it("registers, returns the user, and keeps the session", async () => {
    const r = await agent.post("/api/auth/register").send({ email: "ari@test.dev", password: "supersecret1" });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe("ari@test.dev");

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("ari@test.dev");
  });

  it("rejects a wrong password with a generic error", async () => {
    const r = await agent.post("/api/auth/login").send({ email: "ari@test.dev", password: "wrongpassword" });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toMatch(/Email atau kata sandi salah/);
  });

  it("rejects unauthenticated access", async () => {
    const anon = supertest.agent(app);
    const r = await anon.get("/api/auth/me");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("preferences", () => {
  it("saves and returns preferences, deduped and normalised", async () => {
    const put = await agent.put("/api/preferences").send({
      sensitivityLevel: "high",
      allergyGroups: ["fragrance", "fragrance"],
      avoidedIngredients: ["Alcohol Denat"],
    });
    expect(put.status).toBe(200);

    const got = await agent.get("/api/preferences");
    expect(got.body.sensitivityLevel).toBe("high");
    expect(got.body.allergyGroups).toEqual(["fragrance"]);
    expect(got.body.avoidedIngredients).toEqual(["alcohol denat"]);
  });

  it("rejects an unknown sensitivity level", async () => {
    const r = await agent.put("/api/preferences").send({ sensitivityLevel: "extreme" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("scan endpoint", () => {
  it("accepts a valid PNG and returns a completed scan", async () => {
    const r = await agent.post("/api/analyze-skin")
      .field("dummy", "1")
      .attach("image", minimalPng(), { filename: "face.png", contentType: "image/png" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("completed");
    expect(r.body.providerId).toBe("stub");
    expect(r.body.scan.skinScore).toBeTypeOf("number");
    expect(r.body.scan.limitations.join(" ")).toMatch(/bukan pengukuran klinis/);
  });

  it("rejects an HTML payload disguised as a JPEG", async () => {
    const r = await agent.post("/api/analyze-skin")
      .attach("image", Buffer.from("<html><script>alert(1)</script></html>"), { filename: "evil.jpg", contentType: "image/jpeg" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("INVALID_IMAGE");
  });

  it("rejects a PNG below the minimum dimension", async () => {
    const r = await agent.post("/api/analyze-skin")
      .attach("image", minimalPng(100, 100), { filename: "small.png", contentType: "image/png" });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/Resolusi terlalu rendah/);
  });

  it("rejects a scan without a file", async () => {
    const r = await agent.post("/api/analyze-skin").field("dummy", "1");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("INVALID_IMAGE");
  });

  it("is deterministic for identical image bytes", async () => {
    const png = minimalPng(700, 700);
    const a = await agent.post("/api/analyze-skin").attach("image", png, { filename: "face.png", contentType: "image/png" });
    const b = await agent.post("/api/analyze-skin").attach("image", png, { filename: "face.png", contentType: "image/png" });
    expect(b.body.scan.skinScore).toBe(a.body.scan.skinScore);
  });
});

describe("ownership", () => {
  it("another user cannot read my scan and gets 404, not 403", async () => {
    const scan = await agent.post("/api/analyze-skin")
      .attach("image", minimalPng(600, 600), { filename: "face.png", contentType: "image/png" });
    const scanId = scan.body.scanId;

    const intruder = supertest.agent(app);
    await intruder.post("/api/auth/register").send({ email: "intruder@test.dev", password: "supersecret2" });

    const r = await intruder.get(`/api/scans/${scanId}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
  });
});

describe("rate limiting", () => {
  it("returns 429 once the scan budget is spent", async () => {
    const limited = supertest.agent(app);
    await limited.post("/api/auth/register").send({ email: "limited@test.dev", password: "supersecret3" });

    const png = minimalPng(600, 600);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await limited.post("/api/analyze-skin").attach("image", png, { filename: "face.png", contentType: "image/png" })).status;
    }
    expect(last).toBe(429);
  });
});

describe("recommendations", () => {
  it("respects the user's allergy: the fragranced cream is excluded", async () => {
    await agent.put("/api/preferences").send({ allergyGroups: ["fragrance"] });
    const r = await agent.get("/api/recommendations?type=product");
    expect(r.status).toBe(200);
    const names = r.body.products.map((p: { name: string }) => p.name);
    const excludedNames = r.body.excluded.map((p: { name: string }) => p.name);
    expect(names).not.toContain("Moisturizing Cream");
    expect(excludedNames).toContain("Moisturizing Cream");
  });

  it("returns food recommendations with uncertain rows flagged", async () => {
    const r = await agent.get("/api/recommendations?type=food");
    expect(r.status).toBe(200);
    const mystery = r.body.foods.find((f: { name: string }) => f.name === "Bowl jus campuran");
    expect(mystery.recommendationStatus).toBe("uncertain");
  });

  it("echoes the id of the scan the recommendation was built from", async () => {
    const scan = await agent.post("/api/analyze-skin")
      .attach("image", minimalPng(640, 640), { filename: "face.png", contentType: "image/png" });
    const r = await agent.get("/api/recommendations?type=product");
    expect(r.status).toBe(200);
    expect(r.body.scanId).toBe(scan.body.scanId);
  });

  it("ignores a scanId that belongs to another user", async () => {
    const victimScan = await agent.post("/api/analyze-skin")
      .attach("image", minimalPng(720, 720), { filename: "face.png", contentType: "image/png" });

    const stranger = supertest.agent(app);
    await stranger.post("/api/auth/register").send({ email: "stranger@test.dev", password: "supersecret4" });
    const r = await stranger.get(`/api/recommendations?type=product&scanId=${victimScan.body.scanId}`);

    expect(r.status).toBe(200);
    // Never echo an id the caller does not own; with no scan of their own, it falls back.
    expect(r.body.scanId).toBeNull();
    expect(r.body.products).toEqual([]);
  });
});

describe("ingredient checker", () => {
  it("blocks a list containing the user's allergy", async () => {
    await agent.put("/api/preferences").send({ allergyGroups: ["fragrance"] });
    const r = await agent.post("/api/ingredients/analyze").send({ ingredientText: "Aqua, Glycerin, Parfum" });
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe("not_recommended");
  });
});

describe("assistant", () => {
  it("returns a safe fallback when no LLM provider is configured", async () => {
    const r = await agent.post("/api/assistant/chat").send({ message: "Kulitku kenapa ya?" });
    expect([200, 503]).toContain(r.status);
  });
});

describe("deletion", () => {
  it("deletes a scan and then returns 404", async () => {
    const scan = await agent.post("/api/analyze-skin")
      .attach("image", minimalPng(600, 600), { filename: "face.png", contentType: "image/png" });
    const id = scan.body.scanId;
    const del = await agent.delete(`/api/scans/${id}`);
    expect(del.status).toBe(204);
    const gone = await agent.get(`/api/scans/${id}`);
    expect(gone.status).toBe(404);
  });
});

describe("regressions from the UI build", () => {
  it("serves the test console at /", async () => {
    const r = await agent.get("/");
    expect(r.status).toBe(200);
    expect(r.text).toContain("FaceWish");
    expect(r.headers["content-type"]).toContain("text/html");
  });

  it("lists scans as an array (get() vs all() regression)", async () => {
    await agent.post("/api/analyze-skin")
      .attach("image", minimalPng(600, 600), { filename: "face.png", contentType: "image/png" });

    const r = await agent.get("/api/scans?limit=10");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items[0]).toHaveProperty("scanId");
    expect(r.body.items[0]).toHaveProperty("status");
  });

  it("answers the session probe without 401 when anonymous", async () => {
    const fresh = supertest.agent(app);
    const anon = await fresh.get("/api/auth/session");
    expect(anon.status).toBe(200);
    expect(anon.body.user).toBeNull();

    await fresh.post("/api/auth/register").send({ email: "session@test.dev", password: "supersecret9" });
    const signedIn = await fresh.get("/api/auth/session");
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user.email).toBe("session@test.dev");
  });

  it("rejects an oversized upload with 422, not 500", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const r = await agent.post("/api/analyze-skin")
      .attach("image", big, { filename: "big.png", contentType: "image/png" });

    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("INVALID_IMAGE");
    expect(r.body.error.requestId).toMatch(/^req_/);
  });

  it("returns a JSON envelope for unknown API paths", async () => {
    const r = await agent.get("/api/does-not-exist");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
    expect(r.body.error.requestId).toMatch(/^req_/);
  });
});

describe("input validation", () => {
  it("turns malformed JSON into a 400, not a 500", async () => {
    const r = await agent
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email":oops');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("clamps a negative limit instead of erroring", async () => {
    const r = await agent.get("/api/scans?limit=-5");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
  });

  it("rejects an unknown recommendation type", async () => {
    const r = await agent.get("/api/recommendations?type=bogus");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
  });
});
