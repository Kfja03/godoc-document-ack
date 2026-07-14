import { createApp } from "./app";
import db from "./db";
import { createUser, getUserByEmail } from "./lib/users";
import { DEMO_USERS } from "./db/demoUsers";
import { getRetentionDays, purgeExpiredRejectedDocuments } from "./lib/retention";

// Convenience for local/demo use (including `docker compose up`, where
// there's no separate terminal to run `npm run seed` from): if the users
// table is empty on boot, seed the same demo accounts `npm run seed`
// creates. This never runs in tests (they import ./app directly, not this
// file) and never overwrites existing users.
function seedDemoUsersIfEmpty() {
  const { count } = db.prepare(`SELECT COUNT(*) as count FROM users`).get() as { count: number };
  if (count > 0) return;
  for (const u of DEMO_USERS) {
    if (!getUserByEmail(u.email)) createUser(u);
  }
  console.log("No users found - seeded demo accounts (see README for credentials).");
}

// Naive in-process scheduler: run the purge once at boot, then every 6
// hours. This is a deliberate shortcut for a take-home assessment - it
// only runs while this one process is up, doesn't coordinate across
// multiple instances (each would run its own redundant sweep), and a
// missed window because the process was down just means expired documents
// live a bit longer, not that anything breaks. A real production version
// would be a proper cron job / scheduled worker (e.g. a queue consumer or
// a platform cron trigger) hitting the same purgeExpiredRejectedDocuments
// function, which is already decoupled from HTTP and testable on its own.
function schedulePurgeJob() {
  const uploadDir = process.env.UPLOAD_DIR || "./uploads";
  const retentionDays = getRetentionDays();

  const run = () => {
    const purged = purgeExpiredRejectedDocuments(uploadDir, retentionDays);
    if (purged.length > 0) {
      console.log(`Purged ${purged.length} rejected document(s) older than ${retentionDays} days.`);
    }
  };

  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

seedDemoUsersIfEmpty();
schedulePurgeJob();

const app = createApp();
const port = Number(process.env.PORT || 4000);

app.listen(port, () => {
  console.log(`GoDoc document-ack API listening on http://localhost:${port}`);
});
