import "dotenv/config";
import db from "./index";

// Importing ./index already creates the schema (idempotent, CREATE TABLE IF
// NOT EXISTS). This script exists as an explicit, documented entry point
// for "run migrations" per the README instructions.
console.log(`Migration complete. DB at ${process.env.DATABASE_PATH || "./data/dev.db"}`);
db.close();
