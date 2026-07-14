import fs from "fs";
import path from "path";

// Isolate each test *file* in its own SQLite file / upload dir so tests
// never see leftover state from previous runs or from `npm run dev`.
const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const dbPath = path.join(__dirname, `../data/test-${runId}.db`);
const uploadDir = path.join(__dirname, `../uploads_test/test-${runId}`);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

process.env.DATABASE_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.MAX_FILE_SIZE_MB = "1";
process.env.ALLOWED_MIME_TYPES = "application/pdf,image/png";
