import { v4 as uuidv4 } from "uuid";
import db from "../db";
import { DocumentStatus, canTransition, nextState } from "./stateMachine";
import type { Role } from "./roles";
import { canApprove } from "./roles";

export interface DocumentRow {
  id: string;
  original_filename: string;
  stored_filename: string;
  mime_type: string;
  size_bytes: number;
  uploader_id: string;
  uploader_name: string;
  status: DocumentStatus;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by_id: string | null;
  acknowledged_by_name: string | null;
  rejected_at: string | null;
  rejected_by_id: string | null;
  rejected_by_name: string | null;
  rejection_reason: string | null;
}

// Every read goes through this same joined SELECT so API responses always
// carry human-readable uploader/reviewer names alongside their ids, without
// the frontend needing a second round trip to resolve them.
const SELECT_DOCUMENT = `
  SELECT
    d.*,
    up.name AS uploader_name,
    ak.name AS acknowledged_by_name,
    rj.name AS rejected_by_name
  FROM documents d
  JOIN users up ON up.id = d.uploader_id
  LEFT JOIN users ak ON ak.id = d.acknowledged_by_id
  LEFT JOIN users rj ON rj.id = d.rejected_by_id
`;

export interface CreateDocumentInput {
  originalFilename: string;
  storedFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploaderId: string;
}

export function createDocument(input: CreateDocumentInput): DocumentRow {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO documents
      (id, original_filename, stored_filename, mime_type, size_bytes, uploader_id, status)
     VALUES (?, ?, ?, ?, ?, ?, 'UPLOADED')`
  ).run(id, input.originalFilename, input.storedFilename, input.mimeType, input.sizeBytes, input.uploaderId);
  return getDocumentRow(id)!;
}

export function getDocumentRow(id: string): DocumentRow | undefined {
  return db.prepare(`${SELECT_DOCUMENT} WHERE d.id = ?`).get(id) as unknown as DocumentRow | undefined;
}

export interface ListOptions {
  status?: DocumentStatus;
  search?: string;
}

/**
 * Visibility rules (enforced here, not just hidden in the UI):
 *  - A user with approval capability (APPROVE_ONLY or UPLOAD_AND_APPROVE)
 *    can see every document - they need the full pending queue to review.
 *  - A user without approval capability (UPLOAD_ONLY) can only see:
 *      (a) documents they uploaded themselves, in any status, and
 *      (b) any document from anyone that has been ACKNOWLEDGED.
 *    They can never see another user's pending or rejected document.
 */
export function listDocumentsForUser(
  user: { id: string; role: Role },
  options: ListOptions = {}
): DocumentRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!canApprove(user.role)) {
    clauses.push(`(d.uploader_id = ? OR d.status = 'ACKNOWLEDGED')`);
    params.push(user.id);
  }

  if (options.status) {
    clauses.push(`d.status = ?`);
    params.push(options.status);
  }

  if (options.search) {
    clauses.push(`d.original_filename LIKE ? COLLATE NOCASE`);
    params.push(`%${options.search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`${SELECT_DOCUMENT} ${where} ORDER BY d.created_at DESC`)
    .all(...(params as [])) as unknown as DocumentRow[];
}

export function canUserSeeDocument(user: { id: string; role: Role }, doc: DocumentRow): boolean {
  if (canApprove(user.role)) return true;
  return doc.uploader_id === user.id || doc.status === "ACKNOWLEDGED";
}

export type TransitionResult =
  | { ok: true; document: DocumentRow }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "INVALID_TRANSITION"; currentStatus: DocumentStatus };

/**
 * The UPDATE ... WHERE status = 'UPLOADED' guard makes this atomic at the
 * database level: if two requests race to act on the same document, only
 * the first UPDATE actually changes a row. The second sees changes = 0 and
 * is told the transition is no longer valid, rather than silently
 * overwriting the first reviewer's decision.
 */
function applyTransition(
  id: string,
  event: "ACKNOWLEDGE" | "REJECT",
  actorId: string,
  reason?: string
): TransitionResult {
  const existing = getDocumentRow(id);
  if (!existing) return { ok: false, reason: "NOT_FOUND" };

  if (!canTransition(existing.status, event)) {
    return { ok: false, reason: "INVALID_TRANSITION", currentStatus: existing.status };
  }

  const target = nextState(existing.status, event);

  const result =
    target === "ACKNOWLEDGED"
      ? db
          .prepare(
            `UPDATE documents
             SET status = 'ACKNOWLEDGED', acknowledged_at = datetime('now'), acknowledged_by_id = ?
             WHERE id = ? AND status = 'UPLOADED'`
          )
          .run(actorId, id)
      : db
          .prepare(
            `UPDATE documents
             SET status = 'REJECTED', rejected_at = datetime('now'), rejected_by_id = ?, rejection_reason = ?
             WHERE id = ? AND status = 'UPLOADED'`
          )
          .run(actorId, reason || null, id);

  if (result.changes === 0) {
    const current = getDocumentRow(id)!;
    return { ok: false, reason: "INVALID_TRANSITION", currentStatus: current.status };
  }

  return { ok: true, document: getDocumentRow(id)! };
}

export function acknowledgeDocument(id: string, actorId: string): TransitionResult {
  return applyTransition(id, "ACKNOWLEDGE", actorId);
}

export function rejectDocument(id: string, actorId: string, reason?: string): TransitionResult {
  return applyTransition(id, "REJECT", actorId, reason);
}
