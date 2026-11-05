// Public-path check: drives the app through the ngrok tunnel, not localhost.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1200, height: 1700 },
  extraHTTPHeaders: { "ngrok-skip-browser-warning": "true" },
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#auth-card:not(.hidden)", { timeout: 30000 });
console.log("page:", (await page.title()).slice(0, 40));

await page.click('button[data-mode="register"]');
await page.fill("#email", `pub${Date.now()}@facewish.dev`);
await page.fill("#password", "password123");
await page.click("#auth-submit");
await page.waitForSelector("#app:not(.hidden)", { timeout: 30000 });
console.log("register: ok (cookie survives https)");

await page.setInputFiles("#scan-file", "data/face-test.jpg");
await page.click("#scan-submit");
await page.waitForSelector("#score-val:not(:empty)", { timeout: 120000 });
console.log("score:", (await page.textContent("#score-val"))?.trim(), (await page.textContent("#score-label"))?.trim());
console.log("provider:", (await page.textContent("#provider-badge"))?.trim());

await page.waitForFunction(() => document.querySelectorAll("#rec-list .item").length > 0, { timeout: 30000 });
console.log("recommendations:", await page.locator("#rec-list .item").count());

await page.waitForTimeout(1200);
await page.screenshot({ path: "data/public-shot.png", fullPage: true });
console.log("errors:", errors.length ? errors.slice(0, 3) : "none");
await browser.close();
