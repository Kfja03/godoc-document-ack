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
  getActiveDocumentRow,
  listDocumentsForUser,
  rejectDocument,
  replaceDocumentFile,
  requestRevisionDocument,
  resubmitDocument,
  softDeleteDocument,
} from "../lib/documents";
import {
  requireAuth,
  requireApproveCapability,
  requireManageCapability,
  requireUploadCapability,
} from "../middleware/auth";
import { canManage } from "../lib/roles";
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

const VALID_STATUSES: DocumentStatus[] = ["UPLOADED", "ACKNOWLEDGED", "REJECTED", "NEEDS_REVISION"];

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
  const doc = getActiveDocumentRow(req.params.id);
  if (!doc || !canUserSeeDocument(req.user!, doc)) {
    return res.status(404).json({ error: "Document not found." });
  }
  return res.json(doc);
});

// GET /api/documents/:id/download
router.get("/:id/download", (req: Request, res: Response) => {
  const doc = getActiveDocumentRow(req.params.id);
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

// POST /api/documents/:id/request-revision (requires approval capability)
// "This is broadly right but needs a fix / more info" - distinct from an
// outright reject. Puts the document in NEEDS_REVISION, which only the
// document's own uploader (or a lead) can resolve via /resubmit.
router.post("/:id/request-revision", requireApproveCapability, (req: Request, res: Response) => {
  const { note } = req.body || {};
  const result = requestRevisionDocument(req.params.id, req.user!.id, note);
  if (!result.ok) {
    if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Document not found." });
    return res.status(409).json({
      error: `Document cannot have revision requested from its current status: ${result.currentStatus}`,
    });
  }
  return res.json(result.document);
});

// POST /api/documents/:id/resubmit (requires upload capability) - the
// uploader's response to a request-revision: a corrected file that sends
// the document back to UPLOADED. Scoped to the document's own uploader, or
// a lead acting on their behalf (same canManage() used for edit/delete).
router.post(
  "/:id/resubmit",
  requireUploadCapability,
  upload.single("file"),
  (req: Request, res: Response) => {
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
      fs.unlink(file.path, () => {});
      return res.status(400).json({ errors: validation.errors });
    }

    const result = resubmitDocument(
      req.params.id,
      { id: req.user!.id, canManage: canManage(req.user!.role) },
      {
        originalFilename: file.originalname,
        storedFilename: file.filename,
        mimeType: file.mimetype,
        sizeBytes: file.size,
      }
    );

    if (!result.ok) {
      fs.unlink(file.path, () => {});
      if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Document not found." });
      if (result.reason === "FORBIDDEN") {
        return res.status(403).json({ error: "Only the original uploader (or a lead) can resubmit this document." });
      }
      return res.status(409).json({
        error: `Document cannot be resubmitted from its current status: ${result.currentStatus}`,
      });
    }

    return res.json(result.document);
  }
);

// PATCH /api/documents/:id - lead-only: replace the file on an existing
// document. Resets it to UPLOADED (see replaceDocumentFile for why).
router.patch(
  "/:id",
  requireManageCapability,
  upload.single("file"),
  (req: Request, res: Response) => {
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
      fs.unlink(file.path, () => {});
      return res.status(400).json({ errors: validation.errors });
    }

    const result = replaceDocumentFile(req.params.id, {
      originalFilename: file.originalname,
      storedFilename: file.filename,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    });

    if (!result.ok) {
      fs.unlink(file.path, () => {});
      return res.status(404).json({ error: "Document not found." });
    }

    // Clean up the file being replaced now that the DB points at the new one.
    fs.unlink(path.join(uploadDir, result.oldStoredFilename), () => {});
    return res.json(result.document);
  }
);

// DELETE /api/documents/:id - lead-only: soft delete. Hides the document
// immediately; the row and file are permanently removed later by the
// retention sweep (see src/lib/retention.ts).
router.delete("/:id", requireManageCapability, (req: Request, res: Response) => {
  const result = softDeleteDocument(req.params.id);
  if (!result.ok) {
    return res.status(404).json({ error: "Document not found." });
  }
  return res.status(204).send();
});

export default router;
