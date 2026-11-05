import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { get } from "./db";
import { errorHandler, notFound, requestId } from "./http/middleware";
import { authRouter } from "./http/routes/auth";
import { preferencesRouter } from "./http/routes/preferences";
import { analyzeWithUpload, scansRouter } from "./http/routes/scans";
import { ingredientsRouter, recommendationsRouter } from "./http/routes/recommendations";
import { assistantRouter } from "./http/routes/assistant";

/** Express app without listen() so tests can drive it with supertest-style calls. */
export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestId);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/healthz", (_req, res) => {
    let dbOk = false;
    try {
      dbOk = !!get("SELECT 1 AS ok");
    } catch {
      dbOk = false;
    }
    res.json({
      ok: true,
      db: dbOk,
      provider: config.vision.provider,
      nodeEnv: config.nodeEnv,
    });
  });

  // Test console: plain static files, no build step.
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
  app.use(express.static(webRoot, { index: "index.html", maxAge: 0 }));

  // Auth routes are named /register, /login... and the spec path is /api/auth/*.
  app.use("/api/auth", authRouter);
  app.use("/api", preferencesRouter);

  // The scan route needs multipart parsing; bound here, exactly once. Multer errors are
  // translated to the documented 422 envelope instead of leaking as 500s.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.limits.maxUploadBytes } });
  const uploadImage: import("express").RequestHandler = (req, res, next) => {
    upload.single("image")(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const tooBig = err.code === "LIMIT_FILE_SIZE";
        res.status(422).json({
          error: {
            code: "INVALID_IMAGE",
            message: tooBig ? "Ukuran foto melebihi 5 MB." : "Berkas tidak dapat diproses.",
            details: { reason: err.code },
            requestId: req.requestId,
          },
        });
        return;
      }
      next(err);
    });
  };
  app.post("/api/analyze-skin", uploadImage, analyzeWithUpload);
  app.use("/api", scansRouter);

  app.use("/api", recommendationsRouter);
  app.use("/api", ingredientsRouter);
  app.use("/api", assistantRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
