import fs from "fs";
import path from "path";
import { deleteDocumentPermanently, findExpiredRejectedDocuments, type DocumentRow } from "./documents";

export const DEFAULT_RETENTION_DAYS = 30;

export function getRetentionDays(): number {
  const fromEnv = Number(process.env.REJECTED_RETENTION_DAYS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RETENTION_DAYS;
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
  retentionDays: number = getRetentionDays(),
  now: Date = new Date()
): DocumentRow[] {
  const expired = findExpiredRejectedDocuments(retentionDays, now);

  for (const doc of expired) {
    const filePath = path.join(uploadDir, doc.stored_filename);
    try {
      fs.unlinkSync(filePath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.error(`Failed to delete file for purged document ${doc.id}:`, err);
      }
    }
    deleteDocumentPermanently(doc.id);
  }

  return expired;
}
