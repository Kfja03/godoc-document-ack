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
// under an older schema - it does NOT alter it, and SQLite CHECK
// constraints can't be altered in place. There's no migration tool wired up
// for this assessment (see README "Known limitations"), so a `documents`
// table left over from before this schema revision would otherwise cause a
// confusing raw SQLite crash the first time this runs against old data.
// Detect that case and fail fast with an actionable message instead.
const existingColumns = (db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]).map(
  (c) => c.name
);
const documentsTableExists = existingColumns.length > 0;
// uploader_id: added when role-based access was introduced.
// deleted_at / revision_requested_at: added when soft-delete and the
// "request revision" state were introduced.
const hasCurrentSchema =
  existingColumns.includes("uploader_id") &&
  existingColumns.includes("deleted_at") &&
  existingColumns.includes("revision_requested_at");

if (documentsTableExists && !hasCurrentSchema) {
  throw new Error(
    `The database at "${dbPath}" predates the current documents schema (role-based access, ` +
      `the NEEDS_REVISION state, and/or soft-delete columns are missing) and there's no ` +
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
    status TEXT NOT NULL
      CHECK (status IN ('UPLOADED', 'ACKNOWLEDGED', 'REJECTED', 'NEEDS_REVISION'))
      DEFAULT 'UPLOADED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged_at TEXT,
    acknowledged_by_id TEXT REFERENCES users(id),
    rejected_at TEXT,
    rejected_by_id TEXT REFERENCES users(id),
    rejection_reason TEXT,
    revision_requested_at TEXT,
    revision_requested_by_id TEXT REFERENCES users(id),
    revision_note TEXT,
    -- Soft delete: set by the lead-only DELETE endpoint. A non-null
    -- deleted_at hides the row from every normal read path immediately;
    -- the row and its file are only actually removed by the retention
    -- sweep once deleted_at is older than DELETED_RETENTION_DAYS. See
    -- README "Editing, deletion & retention".
    deleted_at TEXT
  );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);");
db.exec("CREATE INDEX IF NOT EXISTS idx_documents_uploader ON documents(uploader_id);");
db.exec("CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at);");

export default db;
