// Drives the real UI in Chrome: register → preferences → scan → recommendations →
// ingredient check → history → delete. Fails loudly on any console/page error.
//
// Self-contained: unless BASE_URL is set, it boots its own throwaway server on :4399
// (stub vision provider, temp SQLite) so the check never depends on a running dev server.
import { chromium } from "playwright-core";
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const email = `ui-${Date.now()}@facewish.dev`;
const password = "password123";

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = (180 + seed) % 256;
      raw[o + 1] = 150;
      raw[o + 2] = 140;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const problems = [];
const step = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) problems.push(name + (extra ? ": " + extra : ""));
};

mkdirSync("data", { recursive: true });
const face = `data/ui-face-${Date.now()}.png`;
writeFileSync(face, makePng(600, 600, 7));

// --- optional throwaway server -------------------------------------------------
let server = null;
let serverDb = null;
let base = process.env.BASE_URL;

if (!base) {
  const port = Number(process.env.UI_PORT ?? 4399);
  base = `http://localhost:${port}`;
  serverDb = `data/ui-test-${Date.now()}.db`;
  server = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      DB_PATH: serverDb,
      SESSION_SECRET: "ui-smoke-secret-not-for-production",
      VISION_PROVIDER: "stub",
      LLM_PROVIDER: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => {
    const line = String(d).trim();
    if (line) console.error("[server]", line);
  });

  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server uji tidak siap dalam 30 detik");
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`(server uji: ${base}, provider stub)\n`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#auth-card:not(.hidden)");

  step("halaman termuat", (await page.textContent("h1")).includes("Face"));

  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("#auth-submit");
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10000 });
  step("register + masuk", (await page.textContent("#who")).includes(email));

  await page.selectOption("#skinType", "oily");
  await page.selectOption("#sensitivity", "high");
  await page.click('.chip[data-value="fragrance"]');
  await page.fill("#avoided", "alcohol denat");
  await page.click("#save-prefs");
  await page.waitForFunction(() => document.querySelector("#prefs-note").textContent === "tersimpan", { timeout: 8000 });
  step("simpan preferensi", true);

  await page.setInputFiles("#scan-file", face);
  await page.waitForFunction(() => !document.querySelector("#scan-submit").disabled, { timeout: 5000 });
  step("file terpilih", (await page.textContent("#scan-note")).includes(".png"));

  await page.click("#scan-submit");
  await page.waitForFunction(
    () => {
      const v = document.querySelector("#score-val").textContent;
      return v && v !== "—";
    },
    { timeout: 20000 },
  );
  const score = await page.textContent("#score-val");
  const bars = await page.locator("#metric-bars .bar-row").count();
  step("analisis wajah", Number(score) >= 0 && Number(score) <= 100, `skor=${score}, metrik=${bars}`);
  step("enam metrik tampil", bars === 6, String(bars));

  await page.waitForFunction(
    () => document.querySelectorAll("#rec-list .item").length > 0,
    { timeout: 10000 },
  );
  const recCount = await page.locator("#rec-list .item").count();
  step("rekomendasi produk", recCount > 0, `${recCount} item`);

  await page.click('[data-rec="food"]');
  await page.waitForFunction(
    () => document.querySelectorAll("#rec-list .item").length > 0,
    { timeout: 10000 },
  );
  step("rekomendasi makanan", (await page.locator("#rec-list .item").count()) > 0);

  await page.fill("#ingredients", "Aqua, Glycerin, Niacinamide, Parfum");
  await page.click("#check-ingredients");
  await page.waitForFunction(
    () => document.querySelector("#ing-verdict").textContent.includes("verdict"),
    { timeout: 10000 },
  );
  const verdict = await page.textContent("#ing-verdict");
  const ingBad = await page.locator("#ing-list .tag.bad").count();
  step("cek bahan", verdict.includes("not_recommended") && ingBad > 0, verdict);

  const historyCount = await page.locator("#history .item").count();
  step("riwayat scan", historyCount === 1, `${historyCount} entri`);

  await page.screenshot({ path: "data/ui-screenshot.png", fullPage: true });

  await page.click("#history .item button.danger");
  await page.waitForFunction(
    () => document.querySelectorAll("#history .item").length === 0,
    { timeout: 10000 },
  );
  step("hapus scan", true);

  step("tanpa error konsol", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cards: [...document.querySelectorAll(".card")].filter((c) => c.getBoundingClientRect().height > 20).length,
    emptyBlocks: [...document.querySelectorAll(".card")].filter((c) => !c.textContent.trim()).length,
  }));
  step("tidak ada overflow horizontal", layout.overflow <= 0, `overflow=${layout.overflow}px`);
  step("semua kartu punya isi", layout.cards >= 7 && layout.emptyBlocks === 0, `kartu=${layout.cards}`);
} catch (err) {
  step("alur UI", false, String(err).slice(0, 300));
  await page.screenshot({ path: "data/ui-failure.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  if (server) server.kill();
  for (const f of [face, serverDb]) {
    if (f) try { rmSync(f, { force: true }); } catch { /* sqlite may still hold it */ }
  }
}

console.log(problems.length ? `\n${problems.length} MASALAH` : "\nSEMUA LULUS");
process.exit(problems.length ? 1 : 0);
