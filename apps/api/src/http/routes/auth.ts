import { Router } from "express";
import { createHash, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { get, run } from "../../db";
import { HttpError, asyncHandler, hashToken, optionalAuth, requireAuth, rateLimit } from "../../http/middleware";
import { loginSchema, registerSchema, validate } from "../../http/validation";
import { config } from "../../config";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = createHash("sha256").update(randomUUID()).digest();
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const GENERIC_LOGIN_ERROR = "Email atau kata sandi salah.";

export const authRouter = Router();

authRouter.post(
  "/register",
  rateLimit("register", 5, 60 * 60 * 1000),
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, displayName } = req.body as {
      email: string;
      password: string;
      displayName?: string;
    };
    const normalized = email.trim().toLowerCase();
    if (get("SELECT id FROM users WHERE email = ?", normalized)) {
      throw new HttpError("VALIDATION_ERROR", "Email sudah terdaftar.", { fields: [{ path: "email", message: "sudah terdaftar" }] });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    run(
      "INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?,?,?,?,?)",
      id,
      normalized,
      await hashPassword(password),
      displayName?.trim() || normalized.split("@")[0]!,
      now,
    );
    run(
      "INSERT INTO user_preferences (user_id, sensitivity_level, updated_at) VALUES (?,?,?)",
      id,
      "medium",
      now,
    );

    const token = await createSession(id, res);
    auditSafe(id, "auth.register", "user", { userId: id });
    res.status(201).json({ user: { id, email: normalized, displayName: displayName ?? normalized.split("@")[0] }, sessionToken: token });
  }),
);

authRouter.post(
  "/login",
  rateLimit("login", 10, 15 * 60 * 1000),
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = get<{ id: string; email: string; display_name: string; password_hash: string }>(
      "SELECT id, email, display_name, password_hash FROM users WHERE email = ?",
      email.trim().toLowerCase(),
    );
    // Same error and similar cost for unknown email and wrong password.
    if (!user) {
      await hashPassword("timing-equalizer");
      throw new HttpError("UNAUTHENTICATED", GENERIC_LOGIN_ERROR);
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      throw new HttpError("UNAUTHENTICATED", GENERIC_LOGIN_ERROR);
    }
    const token = await createSession(user.id, res);
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name }, sessionToken: token });
  }),
);

authRouter.post("/logout", (req, res) => {
  const token = (req as unknown as { cookies?: Record<string, string> }).cookies?.fw_session;
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
  res.clearCookie(config.cookieName);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/**
 * Session probe for the UI: always 200. Browsers log a console error for every 401,
 * so the "am I logged in?" check must not be a failing request.
 */
authRouter.get("/session", optionalAuth, (req, res) => {
  res.json({ user: req.user ?? null });
});

async function createSession(userId: string, res: import("express").Response): Promise<string> {
  const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  const expires = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000);
  run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
    hashToken(token),
    userId,
    new Date().toISOString(),
    expires.toISOString(),
  );
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProd,
    expires,
  });
  return token;
}

function auditSafe(actorId: string, action: string, entity: string, meta: unknown): void {
  try {
    import("../../db").then(({ audit }) => audit(actorId, action, entity, meta));
  } catch {
    // audit failures must never break auth; logged by the DB layer
  }
}
