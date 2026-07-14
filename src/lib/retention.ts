import fs from "fs";
import path from "path";
import {
  deleteDocumentPermanently,
  findExpiredRejectedDocuments,
  findExpiredSoftDeletedDocuments,
  type DocumentRow,
} from "./documents";

export const DEFAULT_REJECTED_RETENTION_DAYS = 30;
export const DEFAULT_DELETED_RETENTION_DAYS = 365;

export function getRejectedRetentionDays(): number {
  const fromEnv = Number(process.env.REJECTED_RETENTION_DAYS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_REJECTED_RETENTION_DAYS;
}

export function getDeletedRetentionDays(): number {
  const fromEnv = Number(process.env.DELETED_RETENTION_DAYS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_DELETED_RETENTION_DAYS;
}

function removeFileAndRow(uploadDir: string, doc: DocumentRow, label: string) {
  const filePath = path.join(uploadDir, doc.stored_filename);
  try {
    fs.unlinkSync(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.error(`Failed to delete file for purged (${label}) document ${doc.id}:`, err);
    }
  }
  deleteDocumentPermanently(doc.id);
}

/**
 * Deletes every REJECTED document older than the retention window: the
 * file from disk and the row from the DB. Returns what it purged so
 * callers (the scheduled job in server.ts, or a test) can log/assert on
 * it. Best-effort on file removal - a missing file on disk (already
 * deleted, moved, etc.) doesn't stop the DB row from being cleaned up,
 * since a dangling DB row referencing a nonexistent file is worse than a
 * one-off missed unlink.
 */
export function purgeExpiredRejectedDocuments(
  uploadDir: string,
  retentionDays: number = getRejectedRetentionDays(),
  now: Date = new Date()
): DocumentRow[] {
  const expired = findExpiredRejectedDocuments(retentionDays, now);
  for (const doc of expired) removeFileAndRow(uploadDir, doc, "rejected");
  return expired;
}

/**
 * The hard-purge side of soft delete: any document whose deleted_at is
 * older than the retention window (default 365 days) gets its file and
 * row permanently removed. Everything between the soft delete and this
 * sweep, the document is invisible to the API (see
 * getActiveDocumentRow/listDocumentsForUser) but still recoverable in
 * principle - see README "known limitations" on the missing restore
 * endpoint.
 */
export function purgeExpiredSoftDeletedDocuments(
  uploadDir: string,
  retentionDays: number = getDeletedRetentionDays(),
  now: Date = new Date()
): DocumentRow[] {
  const expired = findExpiredSoftDeletedDocuments(retentionDays, now);
  for (const doc of expired) removeFileAndRow(uploadDir, doc, "soft-deleted");
  return expired;
}
