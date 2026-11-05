import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { get } from "../db";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INVALID_IMAGE"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_PROVIDER_OUTPUT"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_IMAGE: 422,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  INVALID_PROVIDER_OUTPUT: 502,
  INTERNAL: 500,
};

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      user?: SessionUser;
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = `req_${createHash("sha1").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 12)}`;
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Endpoint tidak ditemukan.",
      details: {},
      requestId: req.requestId,
    },
  });
}

/** Maps thrown errors to the documented envelope. Never leaks stack or provider payload. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestIdValue = req.requestId ?? "req_unknown";

  if (err instanceof HttpError) {
    res.status(STATUS[err.code]).json({
      error: { code: err.code, message: err.message, details: err.details ?? {}, requestId: requestIdValue },
    });
    return;
  }

  const message = err instanceof Error ? err.message : "Unexpected error";

  // Body-parser failures (bad JSON, oversized body) are client errors, not 500s.
  const parserType = (err as { type?: string }).type;
  if (parserType === "entity.parse.failed" || (err instanceof SyntaxError && "body" in err)) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Body JSON tidak valid.",
        details: {},
        requestId: requestIdValue,
      },
    });
    return;
  }
  if (parserType === "entity.too.large") {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Body permintaan terlalu besar.",
        details: {},
        requestId: requestIdValue,
      },
    });
    return;
  }

  if (/Invalid metric/.test(message)) {
    res.status(502).json({
      error: {
        code: "INVALID_PROVIDER_OUTPUT",
        message: "Output analisis tidak valid. Coba scan ulang.",
        details: { reason: message },
        requestId: requestIdValue,
      },
    });
    return;
  }

  console.error(`[${requestIdValue}] unhandled`, message);
  res.status(500).json({
    error: { code: "INTERNAL", message: "Terjadi kesalahan internal.", details: {}, requestId: requestIdValue },
  });
}

/** Fixed-window limiter. Single-instance only — documented, not pretended otherwise. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(name: string, limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const who = req.user?.id ?? req.ip ?? "anon";
    const key = `${name}:${who}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (bucket.count >= limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: `Terlalu banyak permintaan. Coba lagi dalam ${retryAfter} detik.`,
          details: { retryAfter },
          requestId: req.requestId,
        },
      });
      return;
    }
    bucket.count += 1;
    next();
  };
}

export function resetRateLimits(): void {
  buckets.clear();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Resolves the session cookie to a user, or null. Never throws. */
function resolveSessionUser(req: Request): SessionUser | null {
  const token = (req as unknown as { cookies?: Record<string, string> }).cookies?.fw_session as string | undefined;
  if (!token) return null;
  const row = get<{ user_id: string; expires_at: string }>(
    "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
    hashToken(token),
  );
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  const user = get<{ id: string; email: string; display_name: string }>(
    "SELECT id, email, display_name FROM users WHERE id = ?",
    row.user_id,
  );
  if (!user) return null;
  return { id: user.id, email: user.email, displayName: user.display_name };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const user = resolveSessionUser(req);
  if (!user) {
    next(new HttpError("UNAUTHENTICATED", "Silakan masuk terlebih dahulu."));
    return;
  }
  req.user = user;
  next();
}

/** Populates req.user when a valid session exists, but lets anonymous requests through. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const user = resolveSessionUser(req);
  if (user) req.user = user;
  next();
}
