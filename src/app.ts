import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import documentsRouter from "./routes/documents";
import authRouter from "./routes/auth";

export function createApp() {
  const app = express();
  // credentials: true + reflecting the request origin lets the session
  // cookie flow work even if the frontend is ever served from a different
  // origin than the API (in dev/Docker today they're same-origin via a
  // proxy, so this is mostly defensive).
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/auth", authRouter);
  app.use("/api/documents", documentsRouter);

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ errors: ["File exceeds the maximum allowed size."] });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal server error." });
  });

  return app;
}
