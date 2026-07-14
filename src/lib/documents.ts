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
  revision_requested_at: string | null;
  revision_requested_by_id: string | null;
  revision_requested_by_name: string | null;
  revision_note: string | null;
  deleted_at: string | null;
}

// Every read goes through this same joined SELECT so API responses always
// carry human-readable uploader/reviewer names alongside their ids, without
// the frontend needing a second round trip to resolve them.
const SELECT_DOCUMENT = `
  SELECT
    d.*,
    up.name AS uploader_name,
    ak.name AS acknowledged_by_name,
    rj.name AS rejected_by_name,
    rv.name AS revision_requested_by_name
  FROM documents d
  JOIN users up ON up.id = d.uploader_id
  LEFT JOIN users ak ON ak.id = d.acknowledged_by_id
  LEFT JOIN users rj ON rj.id = d.rejected_by_id
  LEFT JOIN users rv ON rv.id = d.revision_requested_by_id
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

// Raw lookup - does NOT filter out soft-deleted rows. Used internally by
// transition logic (which needs to see a document's true current state,
// including "already deleted", to return the right error) and by the
// hard-purge sweep. Route handlers that serve a document to a client
// should use getActiveDocumentRow instead.
export function getDocumentRow(id: string): DocumentRow | undefined {
  return db.prepare(`${SELECT_DOCUMENT} WHERE d.id = ?`).get(id) as unknown as DocumentRow | undefined;
}

// Everything client-facing goes through this: a soft-deleted document does
// not exist as far as the API surface is concerned.
export function getActiveDocumentRow(id: string): DocumentRow | undefined {
  const doc = getDocumentRow(id);
  if (!doc || doc.deleted_at) return undefined;
  return doc;
}

export interface ListOptions {
  status?: DocumentStatus;
  search?: string;
}

/**
 * Visibility rules (enforced here, not just hidden in the UI):
 *  - Soft-deleted documents are excluded for everyone, regardless of role.
 *  - A user with approval capability (APPROVE_ONLY or UPLOAD_AND_APPROVE)
 *    can see every remaining document - they need the full queue to review.
 *  - A user without approval capability (UPLOAD_ONLY) can only see:
 *      (a) documents they uploaded themselves, in any status, and
 *      (b) any document from anyone that has been ACKNOWLEDGED.
 *    They can never see another user's pending, rejected, or
 *    needs-revision document.
 */
export function listDocumentsForUser(
  user: { id: string; role: Role },
  options: ListOptions = {}
): DocumentRow[] {
  const clauses: string[] = [`d.deleted_at IS NULL`];
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

  const where = `WHERE ${clauses.join(" AND ")}`;
  return db
    .prepare(`${SELECT_DOCUMENT} ${where} ORDER BY d.created_at DESC`)
    .all(...(params as [])) as unknown as DocumentRow[];
}

export function canUserSeeDocument(user: { id: string; role: Role }, doc: DocumentRow): boolean {
  if (doc.deleted_at) return false;
  if (canApprove(user.role)) return true;
  return doc.uploader_id === user.id || doc.status === "ACKNOWLEDGED";
}

export type TransitionResult =
  | { ok: true; document: DocumentRow }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "INVALID_TRANSITION"; currentStatus: DocumentStatus };

/**
 * The UPDATE ... WHERE status = <from> guard makes this atomic at the
 * database level: if two requests race to act on the same document, only
 * the first UPDATE actually changes a row. The second sees changes = 0 and
 * is told the transition is no longer valid, rather than silently
 * overwriting the first reviewer's decision.
 */
function applyTransition(
  id: string,
  event: "ACKNOWLEDGE" | "REJECT" | "REQUEST_REVISION",
  actorId: string,
  note?: string
): TransitionResult {
  const existing = getActiveDocumentRow(id);
  if (!existing) return { ok: false, reason: "NOT_FOUND" };

  if (!canTransition(existing.status, event)) {
    return { ok: false, reason: "INVALID_TRANSITION", currentStatus: existing.status };
  }

  const target = nextState(existing.status, event);

  let result;
  if (target === "ACKNOWLEDGED") {
    result = db
      .prepare(
        `UPDATE documents
         SET status = 'ACKNOWLEDGED', acknowledged_at = datetime('now'), acknowledged_by_id = ?
         WHERE id = ? AND status = 'UPLOADED'`
      )
      .run(actorId, id);
  } else if (target === "REJECTED") {
    result = db
      .prepare(
        `UPDATE documents
         SET status = 'REJECTED', rejected_at = datetime('now'), rejected_by_id = ?, rejection_reason = ?
         WHERE id = ? AND status = 'UPLOADED'`
      )
      .run(actorId, note || null, id);
  } else {
    result = db
      .prepare(
        `UPDATE documents
         SET status = 'NEEDS_REVISION', revision_requested_at = datetime('now'),
             revision_requested_by_id = ?, revision_note = ?
         WHERE id = ? AND status = 'UPLOADED'`
      )
      .run(actorId, note || null, id);
  }

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

export function requestRevisionDocument(id: string, actorId: string, note?: string): TransitionResult {
  return applyTransition(id, "REQUEST_REVISION", actorId, note);
}

export interface ReplaceFileInput {
  originalFilename: string;
  storedFilename: string;
  mimeType: string;
  sizeBytes: number;
}

export type ReplaceFileResult =
  | { ok: true; document: DocumentRow; oldStoredFilename: string }
  | { ok: false; reason: "NOT_FOUND" };

/**
 * Lead-only "edit": swap the underlying file on an existing document
 * record, from any status. Because the content changed, any prior
 * decision is no longer meaningful, so this resets the document back to
 * UPLOADED and clears acknowledged/rejected/revision fields - it goes back
 * into the review queue rather than staying "approved" against a file
 * nobody actually reviewed. The caller is responsible for deleting
 * `oldStoredFilename` from disk (this module only touches the DB, same
 * convention as the rest of this file).
 */
export function replaceDocumentFile(id: string, input: ReplaceFileInput): ReplaceFileResult {
  const existing = getActiveDocumentRow(id);
  if (!existing) return { ok: false, reason: "NOT_FOUND" };

  db.prepare(
    `UPDATE documents
     SET original_filename = ?, stored_filename = ?, mime_type = ?, size_bytes = ?,
         status = 'UPLOADED',
         acknowledged_at = NULL, acknowledged_by_id = NULL,
         rejected_at = NULL, rejected_by_id = NULL, rejection_reason = NULL,
         revision_requested_at = NULL, revision_requested_by_id = NULL, revision_note = NULL
     WHERE id = ?`
  ).run(input.originalFilename, input.storedFilename, input.mimeType, input.sizeBytes, id);

  return { ok: true, document: getDocumentRow(id)!, oldStoredFilename: existing.stored_filename };
}

export type ResubmitResult =
  | { ok: true; document: DocumentRow; oldStoredFilename: string }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "FORBIDDEN" }
  | { ok: false; reason: "INVALID_TRANSITION"; currentStatus: DocumentStatus };

/**
 * The uploader's own response to a NEEDS_REVISION request: upload a
 * corrected file and send it back into the review queue (-> UPLOADED).
 * Unlike replaceDocumentFile (lead-only, works on anyone's document from
 * any status), this is scoped to the document's own uploader OR a lead
 * acting on their behalf, and only from NEEDS_REVISION - it's the
 * resubmission half of the request-revision workflow, not a general edit.
 * Same atomic-conditional-UPDATE pattern as applyTransition, so two
 * concurrent resubmits (or a resubmit racing a lead's edit) can't both
 * "win".
 */
export function resubmitDocument(
  id: string,
  actor: { id: string; canManage: boolean },
  input: ReplaceFileInput
): ResubmitResult {
  const existing = getActiveDocumentRow(id);
  if (!existing) return { ok: false, reason: "NOT_FOUND" };

  if (!actor.canManage && existing.uploader_id !== actor.id) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  if (!canTransition(existing.status, "RESUBMIT")) {
    return { ok: false, reason: "INVALID_TRANSITION", currentStatus: existing.status };
  }

  const result = db
    .prepare(
      `UPDATE documents
       SET original_filename = ?, stored_filename = ?, mime_type = ?, size_bytes = ?,
           status = 'UPLOADED',
           revision_requested_at = NULL, revision_requested_by_id = NULL, revision_note = NULL
       WHERE id = ? AND status = 'NEEDS_REVISION'`
    )
    .run(input.originalFilename, input.storedFilename, input.mimeType, input.sizeBytes, id);

  if (result.changes === 0) {
    const current = getDocumentRow(id)!;
    return { ok: false, reason: "INVALID_TRANSITION", currentStatus: current.status };
  }

  return { ok: true, document: getDocumentRow(id)!, oldStoredFilename: existing.stored_filename };
}

export type DeleteResult =
  | { ok: true; storedFilename: string }
  | { ok: false; reason: "NOT_FOUND" };

/**
 * Lead-only soft delete: sets deleted_at, which hides the document from
 * every read path immediately (see getActiveDocumentRow /
 * listDocumentsForUser). The row and file are left in place for the
 * hard-purge sweep to remove once DELETED_RETENTION_DAYS has passed - see
 * "known limitations" for why there's no restore endpoint (yet) to undo
 * this within that window.
 */
export function softDeleteDocument(id: string): DeleteResult {
  const existing = getActiveDocumentRow(id);
  if (!existing) return { ok: false, reason: "NOT_FOUND" };
  db.prepare(`UPDATE documents SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  return { ok: true, storedFilename: existing.stored_filename };
}

/**
 * Unconditional hard delete of the row - used only by the retention
 * sweeps (both the REJECTED-retention purge and the soft-delete purge),
 * never called directly from a route. Deliberately does not check
 * deleted_at or status; the caller has already decided this row is
 * eligible for permanent removal.
 */
export function deleteDocumentPermanently(id: string): DeleteResult {
  const existing = getDocumentRow(id);
  if (!existing) return { ok: false, reason: "NOT_FOUND" };
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
  return { ok: true, storedFilename: existing.stored_filename };
}

/**
 * Documents that have been REJECTED for longer than `retentionDays`.
 * Pure query, no side effects - the caller (a scheduled job or a test)
 * decides what to do with the result, including deleting the files from
 * disk and the rows from the DB.
 */
export function findExpiredRejectedDocuments(retentionDays: number, now: Date = new Date()): DocumentRow[] {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString().slice(0, 19).replace("T", " ");
  return db
    .prepare(
      `${SELECT_DOCUMENT} WHERE d.status = 'REJECTED' AND d.deleted_at IS NULL AND d.rejected_at <= ? ORDER BY d.rejected_at ASC`
    )
    .all(cutoffIso) as unknown as DocumentRow[];
}

/**
 * Soft-deleted documents whose deleted_at is older than `retentionDays` -
 * the hard-purge side of the soft-delete lifecycle. Same pure-query shape
 * as findExpiredRejectedDocuments, for the same reason (testable without a
 * scheduler, callable from server.ts's sweep).
 */
export function findExpiredSoftDeletedDocuments(retentionDays: number, now: Date = new Date()): DocumentRow[] {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString().slice(0, 19).replace("T", " ");
  return db
    .prepare(`${SELECT_DOCUMENT} WHERE d.deleted_at IS NOT NULL AND d.deleted_at <= ? ORDER BY d.deleted_at ASC`)
    .all(cutoffIso) as unknown as DocumentRow[];
}
