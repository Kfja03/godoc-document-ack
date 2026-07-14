import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { validateUpload } from "../lib/validation";
import {
  acknowledgeDocument,
  canUserSeeDocument,
  createDocument,
  getDocumentRow,
  listDocumentsForUser,
  rejectDocument,
} from "../lib/documents";
import { requireAuth, requireApproveCapability, requireUploadCapability } from "../middleware/auth";
import type { DocumentStatus } from "../lib/stateMachine";

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
router.use(requireAuth);

const VALID_STATUSES: DocumentStatus[] = ["UPLOADED", "ACKNOWLEDGED", "REJECTED"];

// POST /api/documents - upload a document (requires upload capability)
router.post("/", requireUploadCapability, upload.single("file"), (req: Request, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ errors: ["No file was provided (field name must be 'file')."] });
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
    uploaderId: req.user!.id,
  });

  return res.status(201).json(doc);
});

// GET /api/documents?status=&search= - list documents visible to the caller
router.get("/", (req: Request, res: Response) => {
  const statusParam = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
  const status =
    statusParam && (VALID_STATUSES as string[]).includes(statusParam)
      ? (statusParam as DocumentStatus)
      : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;

  const docs = listDocumentsForUser(req.user!, { status, search: search || undefined });
  return res.json(docs);
});

// GET /api/documents/:id
router.get("/:id", (req: Request, res: Response) => {
  const doc = getDocumentRow(req.params.id);
  if (!doc || !canUserSeeDocument(req.user!, doc)) {
    return res.status(404).json({ error: "Document not found." });
  }
  return res.json(doc);
});

// GET /api/documents/:id/download
router.get("/:id/download", (req: Request, res: Response) => {
  const doc = getDocumentRow(req.params.id);
  if (!doc || !canUserSeeDocument(req.user!, doc)) {
    return res.status(404).json({ error: "Document not found." });
  }
  const filePath = path.join(uploadDir, doc.stored_filename);
  return res.download(filePath, doc.original_filename);
});

// POST /api/documents/:id/acknowledge (requires approval capability)
router.post("/:id/acknowledge", requireApproveCapability, (req: Request, res: Response) => {
  const result = acknowledgeDocument(req.params.id, req.user!.id);
  if (!result.ok) {
    if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Document not found." });
    return res.status(409).json({
      error: `Document cannot be acknowledged from its current status: ${result.currentStatus}`,
    });
  }
  return res.json(result.document);
});

// POST /api/documents/:id/reject (requires approval capability)
router.post("/:id/reject", requireApproveCapability, (req: Request, res: Response) => {
  const { reason } = req.body || {};
  const result = rejectDocument(req.params.id, req.user!.id, reason);
  if (!result.ok) {
    if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Document not found." });
    return res.status(409).json({
      error: `Document cannot be rejected from its current status: ${result.currentStatus}`,
    });
  }
  return res.json(result.document);
});

export default router;
