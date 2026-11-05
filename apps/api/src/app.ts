import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
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

  // Auth routes are named /register, /login... and the spec path is /api/auth/*.
  app.use("/api/auth", authRouter);
  app.use("/api", preferencesRouter);

  // The scan route needs multipart parsing; bound here, exactly once.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.limits.maxUploadBytes } });
  app.post("/api/analyze-skin", upload.single("image"), analyzeWithUpload);
  app.use("/api", scansRouter);

  app.use("/api", recommendationsRouter);
  app.use("/api", ingredientsRouter);
  app.use("/api", assistantRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
