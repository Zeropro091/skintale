import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Config is read once at boot. A missing required value crashes immediately with a
 * readable message instead of failing later inside a request.
 */

const env = process.env;
const isProd = (env.NODE_ENV ?? "development") === "production";

function required(key: string, fallback?: string): string {
  const value = env[key] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

if (isProd && !env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}
if (isProd && (env.VISION_PROVIDER ?? "stub") === "stub") {
  throw new Error("VISION_PROVIDER=stub is not allowed in production");
}

export const config = {
  nodeEnv: env.NODE_ENV ?? "development",
  isProd,
  port: Number(env.PORT ?? 3000),
  sessionSecret: required("SESSION_SECRET", "dev-only-secret-change-me-please-32chars"),
  cookieName: "fw_session",
  sessionDays: 7,
  /** Local driver is sqlite (node:sqlite). Postgres is the production target. */
  dbPath: resolve(env.DB_PATH ?? "data/facewish.db"),
  vision: {
    provider: (env.VISION_PROVIDER ?? "stub") as "stub" | "openai-compatible",
    baseUrl: env.VISION_BASE_URL ?? "https://openagentic.id/v1",
    apiKey: env.VISION_API_KEY ?? "",
    model: env.VISION_MODEL ?? "",
    timeoutMs: Number(env.VISION_TIMEOUT_MS ?? 30000),
  },
  llm: {
    provider: (env.LLM_PROVIDER ?? "none") as "none" | "openai-compatible",
    baseUrl: env.LLM_BASE_URL ?? "https://openagentic.id/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL ?? "",
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 25000),
  },
  limits: {
    scansPerHour: Number(env.RATE_LIMIT_SCANS_PER_HOUR ?? 10),
    chatsPerHour: Number(env.RATE_LIMIT_CHATS_PER_HOUR ?? 30),
    readsPerMinute: Number(env.RATE_LIMIT_READS_PER_MINUTE ?? 120),
    maxUploadBytes: 5 * 1024 * 1024,
    minDimension: 512,
  },
  webOrigin: env.WEB_ORIGIN ?? `http://localhost:${Number(env.PORT ?? 3000)}`,
} as const;

export function ensureDataDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
