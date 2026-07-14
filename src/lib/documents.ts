import { v4 as uuidv4 } from "uuid";
import db from "../db";
import { DocumentStatus, canTransition, nextState } from "./stateMachine";

export interface DocumentRecord {
  id: string;
  original_filename: string;
  stored_filename: string;
  mime_type: string;
  size_bytes: number;
  uploader_name: string;
  intended_recipient: string;
  status: DocumentStatus;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
}

export interface CreateDocumentInput {
  originalFilename: string;
  storedFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploaderName: string;
  intendedRecipient: string;
}

export function createDocument(input: CreateDocumentInput): DocumentRecord {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO documents
      (id, original_filename, stored_filename, mime_type, size_bytes, uploader_name, intended_recipient, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UPLOADED')`
  ).run(
    id,
    input.originalFilename,
    input.storedFilename,
    input.mimeType,
    input.sizeBytes,
    input.uploaderName,
    input.intendedRecipient
  );
  return getDocument(id)!;
}

export function getDocument(id: string): DocumentRecord | undefined {
  return db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as unknown as
    | DocumentRecord
    | undefined;
}

export function listDocuments(): DocumentRecord[] {
  return db
    .prepare(`SELECT * FROM documents ORDER BY created_at DESC`)
    .all() as unknown as DocumentRecord[];
}

export type TransitionResult =
  | { ok: true; document: DocumentRecord }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "INVALID_TRANSITION"; currentStatus: DocumentStatus };

/**
 * Acknowledge or reject a document.
 *
 * The UPDATE ... WHERE status = 'UPLOADED' guard makes this atomic at the
 * database level: if two requests race to act on the same document (e.g.
 * accidental double-submit, or acknowledge + reject fired close together),
 * only the first UPDATE actually changes a row. The second sees
 * changes = 0 and is told the transition is no longer valid, rather than
 * silently overwriting the first party's decision. This mirrors the same
 * "atomic conditional update" pattern that would be used to prevent a
 * double-booking in the consultation booking option.
 */
function applyTransition(
  id: string,
  event: "ACKNOWLEDGE" | "REJECT",
  actor: string,
  reason?: string
): TransitionResult {
  const existing = getDocument(id);
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
             SET status = 'ACKNOWLEDGED', acknowledged_at = datetime('now'), acknowledged_by = ?
             WHERE id = ? AND status = 'UPLOADED'`
          )
          .run(actor, id)
      : db
          .prepare(
            `UPDATE documents
             SET status = 'REJECTED', rejected_at = datetime('now'), rejected_by = ?, rejection_reason = ?
             WHERE id = ? AND status = 'UPLOADED'`
          )
          .run(actor, reason || null, id);

  if (result.changes === 0) {
    // Someone else transitioned it between our read and our write.
    const current = getDocument(id)!;
    return { ok: false, reason: "INVALID_TRANSITION", currentStatus: current.status };
  }

  return { ok: true, document: getDocument(id)! };
}

export function acknowledgeDocument(id: string, actor: string): TransitionResult {
  return applyTransition(id, "ACKNOWLEDGE", actor);
}

export function rejectDocument(id: string, actor: string, reason?: string): TransitionResult {
  return applyTransition(id, "REJECT", actor, reason);
}
