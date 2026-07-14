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

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploader_name TEXT NOT NULL,
    intended_recipient TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('UPLOADED', 'ACKNOWLEDGED', 'REJECTED')) DEFAULT 'UPLOADED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    rejected_at TEXT,
    rejected_by TEXT,
    rejection_reason TEXT
  );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);");

export default db;
