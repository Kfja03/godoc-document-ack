import { createApp } from "./app";
import db from "./db";
import { createUser, getUserByEmail } from "./lib/users";
import { DEMO_USERS } from "./db/demoUsers";

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

seedDemoUsersIfEmpty();

const app = createApp();
const port = Number(process.env.PORT || 4000);

app.listen(port, () => {
  console.log(`GoDoc document-ack API listening on http://localhost:${port}`);
});
