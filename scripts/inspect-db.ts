import { DatabaseSync } from "node:sqlite";

const d = new DatabaseSync(process.argv[2] ?? "data/smoke.db");
const show = (label: string, sql: string) => {
  try {
    console.log(label, JSON.stringify(d.prepare(sql).all()));
  } catch (err) {
    console.log(label, "ERR", (err as Error).message);
  }
};
show("scans:", "SELECT id, status, skin_score FROM scans");
show("products:", "SELECT COUNT(*) AS c FROM products");
show("foods:", "SELECT COUNT(*) AS c FROM foods");
d.close();
