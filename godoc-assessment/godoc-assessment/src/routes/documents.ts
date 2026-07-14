import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { validateUpload } from "../lib/validation";
import {
  acknowledgeDocument,
  createDocument,
  getDocument,
  listDocuments,
  rejectDocument,
} from "../lib/documents";

const uploadDir = process.env.UPLOAD_DIR || "./uploads";
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024 },
});

const router = Router();

// POST /api/documents - upload a document
router.post("/", upload.single("file"), (req: Request, res: Response) => {
  const file = req.file;
  const { uploaderName, intendedRecipient } = req.body;

  if (!file) {
    return res.status(400).json({ errors: ["No file was provided (field name must be 'file')."] });
  }
  if (!uploaderName || !intendedRecipient) {
    fs.unlink(file.path, () => {});
    return res
      .status(400)
      .json({ errors: ["uploaderName and intendedRecipient are both required."] });
  }

  const validation = validateUpload({
    mimeType: file.mimetype,
    sizeBytes: file.size,
    originalFilename: file.originalname,
  });

  if (!validation.valid) {
    fs.unlink(file.path, () => {}); // clean up rejected upload
    return res.status(400).json({ errors: validation.errors });
  }

  const doc = createDocument({
    originalFilename: file.originalname,
    storedFilename: file.filename,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    uploaderName,
    intendedRecipient,
  });

  return res.status(201).json(doc);
});

// GET /api/documents - list all documents
router.get("/", (_req: Request, res: Response) => {
  return res.json(listDocuments());
});

// GET /api/documents/:id - get one document
router.get("/:id", (req: Request, res: Response) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found." });
  return res.json(doc);
});

// GET /api/documents/:id/download - download the file
router.get("/:id/download", (req: Request, res: Response) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found." });
  const filePath = path.join(uploadDir, doc.stored_filename);
  return res.download(filePath, doc.original_filename);
});

// POST /api/documents/:id/acknowledge
router.post("/:id/acknowledge", (req: Request, res: Response) => {
  const { actor } = req.body;
  if (!actor) return res.status(400).json({ error: "actor is required." });

  const result = acknowledgeDocument(req.params.id, actor);
  if (!result.ok) {
    if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Document not found." });
    return res.status(409).json({
      error: `Document cannot be acknowledged from its current status: ${result.currentStatus}`,
    });
  }
  return res.json(result.document);
});

// POST /api/documents/:id/reject
router.post("/:id/reject", (req: Request, res: Response) => {
  const { actor, reason } = req.body;
  if (!actor) return res.status(400).json({ error: "actor is required." });

  const result = rejectDocument(req.params.id, actor, reason);
  if (!result.ok) {
    if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Document not found." });
    return res.status(409).json({
      error: `Document cannot be rejected from its current status: ${result.currentStatus}`,
    });
  }
  return res.json(result.document);
});

export default router;
