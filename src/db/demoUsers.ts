import type { Role } from "../lib/roles";

// Shared by `npm run seed` (explicit, one-off) and the auto-seed-if-empty
// check in src/server.ts (so `docker compose up` works without a manual
// seed step). Passwords are intentionally simple and documented in the
// README - this is seed data for a take-home assessment, not real users.
export const DEMO_USERS: { name: string; email: string; password: string; role: Role }[] = [
  { name: "Alice Tan (Consultant)", email: "alice@godoc.test", password: "password123", role: "UPLOAD_ONLY" },
  { name: "Dana Lim (Consultant)", email: "dana@godoc.test", password: "password123", role: "UPLOAD_ONLY" },
  { name: "Bob Ng (Approver)", email: "bob@godoc.test", password: "password123", role: "APPROVE_ONLY" },
  { name: "Carol Wong (Lead Consultant)", email: "carol@godoc.test", password: "password123", role: "UPLOAD_AND_APPROVE" },
];
