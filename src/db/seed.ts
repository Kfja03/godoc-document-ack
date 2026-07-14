import "dotenv/config";
import db from "./index";
import { createUser, getUserByEmail } from "../lib/users";
import { DEMO_USERS } from "./demoUsers";

for (const u of DEMO_USERS) {
  if (getUserByEmail(u.email)) {
    console.log(`skip (exists): ${u.email}`);
    continue;
  }
  createUser(u);
  console.log(`created: ${u.email} [${u.role}]`);
}

db.close();
