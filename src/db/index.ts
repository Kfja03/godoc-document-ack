import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";

// Uses Node's built-in SQLite module (stable behind an experimental flag as
// of Node 22, see README "Requirements"). Chosen over better-sqlite3 to
// avoid a native-module build step, keeping `npm install` dependency-free
// and reproducible on any machine with Node 22+.
const dbPath = process.env.DATABASE_PATH || "./data/dev.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

// WAL mode: allows concurrent readers while a write is in-flight - the
// standard recommendation for a server process handling concurrent requests
// against a single SQLite file.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    -- UPLOAD_ONLY: can upload, can only see their own documents plus any
    --   ACKNOWLEDGED document from anyone.
    -- APPROVE_ONLY: cannot upload, can see and act on every document.
    -- UPLOAD_AND_APPROVE: both of the above combined.
    role TEXT NOT NULL CHECK (role IN ('UPLOAD_ONLY', 'APPROVE_ONLY', 'UPLOAD_AND_APPROVE')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists
// under the old (pre-auth) schema - it does NOT alter it. There's no
// migration tool wired up (see README "Known limitations"), so a `documents`
// table left over from before role-based access was added (uploader_name /
// intended_recipient columns, no uploader_id) would otherwise cause a
// confusing raw SQLite crash on the CREATE INDEX below the first time this
// runs against old data. Detect that case and fail fast with an actionable
// message instead.
const existingColumns = (db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]).map(
  (c) => c.name
);
const documentsTableExists = existingColumns.length > 0;
const hasCurrentSchema = existingColumns.includes("uploader_id");

if (documentsTableExists && !hasCurrentSchema) {
  throw new Error(
    `The database at "${dbPath}" predates role-based access (it has the old ` +
      `uploader_name/intended_recipient columns, not uploader_id) and there's no ` +
      `migration tool wired up for this assessment. Reset your local dev data:\n` +
      `  - Local: stop the server, delete "${dbPath}" (and any -wal/-shm files next to it), restart.\n` +
      `  - Docker: docker compose down -v && docker compose up --build\n` +
      `(This wipes uploaded demo files too, but there's nothing there worth keeping across a schema change.)`
  );
}

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('UPLOADED', 'ACKNOWLEDGED', 'REJECTED')) DEFAULT 'UPLOADED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged_at TEXT,
    acknowledged_by_id TEXT REFERENCES users(id),
    rejected_at TEXT,
    rejected_by_id TEXT REFERENCES users(id),
    rejection_reason TEXT
  );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);");
db.exec("CREATE INDEX IF NOT EXISTS idx_documents_uploader ON documents(uploader_id);");

export default db;
