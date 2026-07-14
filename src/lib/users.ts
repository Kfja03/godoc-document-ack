import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import db from "../db";
import type { Role } from "./roles";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  created_at: string;
}

export type PublicUser = Omit<UserRecord, "password_hash">;

export function toPublicUser(user: UserRecord): PublicUser {
  const { password_hash, ...rest } = user;
  return rest;
}

export function getUserByEmail(email: string): UserRecord | undefined {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as unknown as
    | UserRecord
    | undefined;
}

export function getUserById(id: string): UserRecord | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as unknown as
    | UserRecord
    | undefined;
}

export function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
}): UserRecord {
  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(input.password, 10);
  db.prepare(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.name, input.email.toLowerCase(), passwordHash, input.role);
  return getUserById(id)!;
}

export function verifyPassword(user: UserRecord, password: string): boolean {
  return bcrypt.compareSync(password, user.password_hash);
}
