import { DatabaseSync } from "node:sqlite";
import { config, ensureDataDir } from "../config";

/**
 * Storage: node:sqlite locally, same repository shape maps to Postgres in production.
 * Images are NOT persisted in this MVP — only a hash. Deleting a scan therefore
 * deletes everything derived from that photo, with no orphan objects in storage.
 */

ensureDataDir(config.dbPath);

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sensitivity_level TEXT NOT NULL DEFAULT 'medium',
  skin_type TEXT,
  allergy_groups TEXT NOT NULL DEFAULT '[]',
  avoided_ingredients TEXT NOT NULL DEFAULT '[]',
  preferred_categories TEXT NOT NULL DEFAULT '[]',
  disliked_ingredients TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  metrics TEXT,
  subscores TEXT,
  skin_score INTEGER,
  score_label TEXT,
  skin_profile TEXT,
  findings TEXT,
  sensitivity_tags TEXT,
  limitations TEXT,
  image_quality TEXT,
  image_sha256 TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  algorithm_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scans_user_created ON scans(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  category TEXT NOT NULL,
  ingredients TEXT NOT NULL,
  ingredient_evidence_status TEXT NOT NULL,
  price_idr INTEGER
);

CREATE TABLE IF NOT EXISTS foods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  allergens TEXT NOT NULL,
  allergen_data_complete INTEGER NOT NULL,
  nutrients TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
`);

type Param = string | number | null;

export function all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number } {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes) };
}

export function audit(actorId: string | null, action: string, entity: string, meta?: unknown): void {
  run(
    "INSERT INTO audit_events (id, actor_id, action, entity, meta, created_at) VALUES (?,?,?,?,?,?)",
    crypto.randomUUID(),
    actorId,
    action,
    entity,
    meta === undefined ? null : JSON.stringify(meta),
    new Date().toISOString(),
  );
}

/** Test/teardown hook: close the handle so Windows allows unlinking the file. */
export function closeDb(): void {
  db.close();
}

export function resetDbForTests(): void {
  for (const table of [
    "messages",
    "conversations",
    "scans",
    "user_preferences",
    "sessions",
    "users",
    "products",
    "foods",
    "audit_events",
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}
