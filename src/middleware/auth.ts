import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/tokens";
import { getUserById, type UserRecord } from "../lib/users";
import { canApprove, canUpload } from "../lib/roles";

export const AUTH_COOKIE = "godoc_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRecord;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[AUTH_COOKIE];
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  const user = getUserById(payload.sub);
  if (!user) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  req.user = user;
  next();
}

export function requireUploadCapability(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !canUpload(req.user.role)) {
    return res.status(403).json({ error: "Your role does not have upload permission." });
  }
  next();
}

export function requireApproveCapability(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !canApprove(req.user.role)) {
    return res.status(403).json({ error: "Your role does not have approval permission." });
  }
  next();
}
