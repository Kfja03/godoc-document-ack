import request from "supertest";
import type { Express } from "express";
import { createUser } from "../src/lib/users";
import type { Role } from "../src/lib/roles";

let counter = 0;

export function makeUser(role: Role, namePrefix = "Test User") {
  counter += 1;
  return createUser({
    name: `${namePrefix} ${counter}`,
    email: `user${counter}-${Date.now()}@example.com`,
    password: "password123",
    role,
  });
}

/** Returns a supertest agent that's already logged in and persists the
 * session cookie across requests, plus the underlying user record. */
export async function loginAs(app: Express, role: Role, namePrefix?: string) {
  const user = makeUser(role, namePrefix);
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email: user.email, password: "password123" });
  if (res.status !== 200) {
    throw new Error(`login failed in test helper: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { agent, user };
}
