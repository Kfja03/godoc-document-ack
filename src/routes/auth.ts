import { Router, Request, Response } from "express";
import { getUserByEmail, toPublicUser, verifyPassword } from "../lib/users";
import { signToken } from "../lib/tokens";
import { AUTH_COOKIE, requireAuth } from "../middleware/auth";

const router = Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days, matches token expiry
  path: "/",
};

router.post("/login", (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required." });
  }

  const user = getUserByEmail(String(email).toLowerCase().trim());
  if (!user || !verifyPassword(user, password)) {
    // Same message for "no such user" and "wrong password" - don't leak
    // which one it was.
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = signToken(user.id);
  res.cookie(AUTH_COOKIE, token, COOKIE_OPTIONS);
  return res.json({ user: toPublicUser(user) });
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(AUTH_COOKIE, { ...COOKIE_OPTIONS, maxAge: undefined });
  return res.json({ ok: true });
});

router.get("/me", requireAuth, (req: Request, res: Response) => {
  return res.json({ user: toPublicUser(req.user!) });
});

export default router;
