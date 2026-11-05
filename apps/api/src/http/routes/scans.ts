import { Router, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { all, get, run } from "../../db";
import { HttpError, asyncHandler, rateLimit, requireAuth } from "../../http/middleware";
import { validateVisionOutput } from "../../http/validation";
import { calculateSkinScore } from "../../modules/scoring/scoring";
import { REQUIRED_LIMITATION } from "../../modules/safety/exclusion";
import { getVisionProvider } from "../../providers/vision";
import { config } from "../../config";

export const scansRouter = Router();

const sniffMime = (buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | null => {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
};

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG IHDR: width/height are big-endian at bytes 16 and 20.
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1]!;
    const length = buf.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** Multipart handler: bound by app.ts with multer, then runs the analysis pipeline. */
export const analyzeWithUpload = [
  rateLimit("scan", config.limits.scansPerHour, 60 * 60 * 1000),
  requireAuth,
  asyncHandler(analyzeScanHandler),
] as unknown as import("express").RequestHandler;

async function analyzeScanHandler(req: Request, res: Response): Promise<void> {
    const file = (req as Request & { file?: { buffer: Buffer; size: number } }).file;
    const image = file?.buffer;
    if (!image || image.length === 0) {
      throw new HttpError("INVALID_IMAGE", "Foto wajah wajib diunggah.");
    }
    if (image.length > config.limits.maxUploadBytes) {
      throw new HttpError("INVALID_IMAGE", "Ukuran foto melebihi 5 MB.");
    }

    // Trust magic bytes, not the declared content type. A payload that claims to be a
    // JPEG but is not a decodable image never reaches the provider.
    const mime = sniffMime(image);
    if (!mime) {
      throw new HttpError("INVALID_IMAGE", "Berkas bukan gambar JPEG/PNG/WebP yang valid.");
    }
    const dims = mime === "image/png" ? pngDimensions(image) : jpegDimensions(image);
    if (!dims) throw new HttpError("INVALID_IMAGE", "Dimensi gambar tidak dapat dibaca.");
    if (dims.width < config.limits.minDimension || dims.height < config.limits.minDimension) {
      throw new HttpError("INVALID_IMAGE", "Resolusi terlalu rendah (minimal 512x512).");
    }
    if (dims.width > 8000 || dims.height > 8000) {
      throw new HttpError("INVALID_IMAGE", "Resolusi terlalu besar (maksimal 8000x8000).");
    }

    const provider = getVisionProvider();
    let raw: unknown;
    try {
      raw = await provider.analyzeSkin({ image, mime });
    } catch (error) {
      const code = (error as { code?: string }).code === "PROVIDER_UNAVAILABLE"
        ? "PROVIDER_UNAVAILABLE"
        : "INVALID_PROVIDER_OUTPUT";
      throw new HttpError(code, code === "PROVIDER_UNAVAILABLE"
        ? "Layanan analisis sedang tidak tersedia. Coba lagi nanti."
        : "Analisis gagal diproses. Coba lagi dengan foto lain.");
    }

    const output = validateVisionOutput(raw);

    if (!output.imageQuality.acceptable) {
      throw new HttpError("INVALID_IMAGE", "Foto tidak dapat dianalisis.", { reasons: output.imageQuality.reasons });
    }

    const score = calculateSkinScore(output.metrics);
    const limitations = [...new Set([...output.limitations, REQUIRED_LIMITATION])];

    const scanId = `sc_${randomUUID()}`;
    const now = new Date().toISOString();
    run(
      `INSERT INTO scans (id, user_id, status, metrics, subscores, skin_score, score_label, skin_profile,
        findings, sensitivity_tags, limitations, image_quality, image_sha256, provider_id, model_id,
        algorithm_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      scanId,
      req.user!.id,
      "completed",
      JSON.stringify(output.metrics),
      JSON.stringify(score.subscores),
      score.skinScore,
      score.scoreLabel,
      output.skinProfile,
      JSON.stringify(output.findings),
      JSON.stringify(output.sensitivityTags),
      JSON.stringify(limitations),
      JSON.stringify(output.imageQuality),
      createHash("sha256").update(image).digest("hex"),
      provider.id,
      provider.model,
      score.algorithmVersion,
      now,
    );

    res.status(200).json({
      scanId,
      status: "completed",
      algorithmVersion: score.algorithmVersion,
      providerId: provider.id,
      scan: {
        metrics: output.metrics,
        subscores: score.subscores,
        skinScore: score.skinScore,
        scoreLabel: score.scoreLabel,
        scoreLabelUi: score.scoreLabelUi,
        skinProfile: output.skinProfile,
        findings: output.findings,
        sensitivityTags: output.sensitivityTags,
        limitations,
        imageQuality: output.imageQuality,
      },
      createdAt: now,
    });
}

scansRouter.get(
  "/scans",
  rateLimit("read", config.limits.readsPerMinute, 60 * 1000),
  requireAuth,
  asyncHandler(async (req, res) => {
    // Clamp: a negative LIMIT reaches sqlite as an error and surfaces as a 500.
    const rawLimit = Number(req.query.limit ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 20, 1), 50);
    // `all`, not `get`: this is a list query (get() returns a single row object).
    const rows = all<{ id: string; created_at: string }>(
      "SELECT id, created_at FROM scans WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
      req.user!.id,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => mapScan(r.id, false));
    res.json({ items, nextCursor: hasMore ? rows[limit - 1]!.created_at : null });
  }),
);

scansRouter.get(
  "/scans/:id",
  rateLimit("read", config.limits.readsPerMinute, 60 * 1000),
  requireAuth,
  asyncHandler(async (req, res) => {
    // Ownership is in the WHERE clause. A foreign id is indistinguishable from a
    // nonexistent one — deliberately, so ids cannot be probed.
    const row = get(
      "SELECT id FROM scans WHERE id = ? AND user_id = ?",
      String(req.params.id),
      req.user!.id,
    );
    if (!row) throw new HttpError("NOT_FOUND", "Scan tidak ditemukan.");
    res.json(mapScan(String(req.params.id), true));
  }),
);

scansRouter.delete(
  "/scans/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = get<{ id: string }>("SELECT id FROM scans WHERE id = ? AND user_id = ?", String(req.params.id), req.user!.id);
    if (!row) throw new HttpError("NOT_FOUND", "Scan tidak ditemukan.");
    run("DELETE FROM scans WHERE id = ?", row.id);
    res.status(204).end();
  }),
);

type ScanRow = {
  id: string;
  status: string;
  metrics: string | null;
  subscores: string | null;
  skin_score: number | null;
  score_label: string | null;
  skin_profile: string | null;
  findings: string | null;
  sensitivity_tags: string | null;
  limitations: string | null;
  image_quality: string | null;
  provider_id: string;
  model_id: string | null;
  algorithm_version: string;
  created_at: string;
};

function mapScan(id: string, full: boolean): Record<string, unknown> {
  const row = get<ScanRow>("SELECT * FROM scans WHERE id = ?", id)!;
  const parsed = (value: string | null) => (value ? JSON.parse(value) : null);
  const base: Record<string, unknown> = {
    scanId: row.id,
    status: row.status,
    algorithmVersion: row.algorithm_version,
    providerId: row.provider_id,
    createdAt: row.created_at,
  };
  if (!full) return base;
  return {
    ...base,
    scan: {
      metrics: parsed(row.metrics),
      subscores: parsed(row.subscores),
      skinScore: row.skin_score,
      scoreLabel: row.score_label,
      skinProfile: row.skin_profile,
      findings: parsed(row.findings),
      sensitivityTags: parsed(row.sensitivity_tags),
      limitations: parsed(row.limitations),
      imageQuality: parsed(row.image_quality),
    },
  };
}
