// Direct provider check: bypasses HTTP so a failure is unambiguous about where it happened.
import { readFileSync } from "node:fs";
import { geminiProvider } from "../apps/api/src/providers/vision";

const image = readFileSync(process.argv[2] ?? "data/face-test.jpg");
const started = Date.now();
const out = await geminiProvider.analyzeSkin({ image, mime: "image/jpeg" });
console.log("provider:", geminiProvider.id, "| model:", geminiProvider.model, "|", Date.now() - started, "ms");
console.log(JSON.stringify(out, null, 1));
