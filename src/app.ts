import "dotenv/config";
import express from "express";
import cors from "cors";
import documentsRouter from "./routes/documents";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
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
