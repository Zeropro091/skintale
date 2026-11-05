import { DatabaseSync } from "node:sqlite";

const d = new DatabaseSync(process.argv[2] ?? "data/smoke3.db");
console.log("foods:", JSON.stringify(d.prepare("SELECT name, category FROM foods").all(), null, 1));
console.log("products:", JSON.stringify(d.prepare("SELECT COUNT(*) AS c FROM products").get()));
d.close();
