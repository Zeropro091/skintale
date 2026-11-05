import { Router } from "express";
import { randomUUID } from "node:crypto";
import { all, get, run } from "../../db";
import { HttpError, asyncHandler, rateLimit, requireAuth } from "../../http/middleware";
import { assistantSchema, validate } from "../../http/validation";
import { validateClaims } from "../../modules/safety/exclusion";
import { config } from "../../config";

export const assistantRouter = Router();

const SYSTEM_PROMPT = `Anda adalah Skin Assistant FaceWish, asisten perawatan kulit.

ATURAN MUTLAK:
1. Anda tidak mendiagnosis penyakit, tidak menjamin hasil, tidak menyebut obat keras.
2. Jangan pernah mengabaikan data alergi pengguna yang diberikan di bawah.
3. Gunakan HANYA informasi dari data di bawah. Jangan mengarang bahan atau studi.
4. Jika pertanyaan medis (jerawat parah, ruam, infeksi, obat resep), sarankan ke dermatolog.
5. Jawab dalam Bahasa Indonesia, maksimal 180 kata.
6. Mulai jawaban tanpa sapaan.

Data pengguna (bisa kosong):
`;

function buildContext(userId: string): string {
  const scan = get(
    "SELECT metrics, skin_score, score_label, status FROM scans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    userId,
  ) as { metrics: string; skin_score: number; score_label: string; status: string } | undefined;
  const prefs = get("SELECT allergy_groups, avoided_ingredients, sensitivity_level FROM user_preferences WHERE user_id = ?", userId) as
    | { allergy_groups: string; avoided_ingredients: string; sensitivity_level: string }
    | undefined;

  const parts: string[] = [];
  if (scan && scan.status === "completed") {
    parts.push(`- Scan terakhir: skor ${scan.skin_score} (${scan.score_label}), metrik ${scan.metrics}`);
  } else {
    parts.push("- Belum ada scan valid.");
  }
  if (prefs) {
    const allergies = JSON.parse(prefs.allergy_groups) as string[];
    const avoided = JSON.parse(prefs.avoided_ingredients) as string[];
    if (allergies.length) parts.push(`- ALERGI (jangan pernah sarankan): ${allergies.join(", ")}`);
    if (avoided.length) parts.push(`- Dihindari pengguna: ${avoided.join(", ")}`);
    parts.push(`- Tingkat sensitivitas: ${prefs.sensitivity_level}`);
  }
  return parts.join("\n");
}

async function callLlm(messages: Array<{ role: string; content: string }>): Promise<string> {
  if (config.llm.provider !== "openai-compatible") {
    throw new HttpError("PROVIDER_UNAVAILABLE", "AI Assistant belum diaktifkan.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const response = await fetch(`${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({ model: config.llm.model, temperature: 0.3, messages }),
    });
    if (!response.ok) throw new HttpError("PROVIDER_UNAVAILABLE", "AI Assistant sedang tidak tersedia.");
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new HttpError("PROVIDER_UNAVAILABLE", "AI Assistant tidak merespons.");
    return content;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new HttpError("PROVIDER_UNAVAILABLE", "AI Assistant kehabisan waktu.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

assistantRouter.post(
  "/assistant/chat",
  rateLimit("chat", config.limits.chatsPerHour, 60 * 60 * 1000),
  requireAuth,
  validate(assistantSchema),
  asyncHandler(async (req, res) => {
    const { message, conversationId } = req.body as { message: string; conversationId?: string };

    let conversation = conversationId;
    if (conversation) {
      const owned = get("SELECT id FROM conversations WHERE id = ? AND user_id = ?", conversation, req.user!.id);
      if (!owned) throw new HttpError("NOT_FOUND", "Percakapan tidak ditemukan.");
    } else {
      conversation = randomUUID();
      run("INSERT INTO conversations (id, user_id, created_at) VALUES (?,?,?)", conversation, req.user!.id, new Date().toISOString());
    }

    const history = all<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 10",
      conversation,
    );

    run(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)",
      randomUUID(),
      conversation,
      "user",
      message,
      new Date().toISOString(),
    );

    const reply = await callLlm([
      { role: "system", content: SYSTEM_PROMPT + buildContext(req.user!.id) },
      ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ]);

    // Model output is data, not truth: validate claims before it reaches the user.
    const claimCheck = validateClaims(reply);
    const safeReply = claimCheck.ok
      ? reply.slice(0, 2000)
      : "Maaf, aku tidak bisa menjawab itu dengan aman. Coba tanya tentang hasil scan, produk, atau bahan skincare. Untuk keluhan medis, sebaiknya periksa ke dermatolog.";

    run(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)",
      randomUUID(),
      conversation,
      "assistant",
      safeReply,
      new Date().toISOString(),
    );

    res.json({ reply: safeReply, conversationId: conversation, claimsViolated: claimCheck.ok ? [] : claimCheck.violations });
  }),
);

assistantRouter.get(
  "/assistant/conversations",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = all(
      "SELECT id, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
      req.user!.id,
    );
    res.json({ items: rows });
  }),
);
