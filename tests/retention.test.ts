import fs from "fs";
import path from "path";
import db from "../src/db";
import { createUser } from "../src/lib/users";
import { createDocument, rejectDocument, getDocumentRow } from "../src/lib/documents";
import { purgeExpiredRejectedDocuments } from "../src/lib/retention";

const uploadDir = process.env.UPLOAD_DIR!;

beforeEach(() => {
  db.exec("DELETE FROM documents");
  db.exec("DELETE FROM users");
});

function makeRejectedDoc(filename: string, daysAgo: number) {
  const uploader = createUser({
    name: "Uploader",
    email: `uploader-${filename}-${Date.now()}@example.com`,
    password: "password123",
    role: "UPLOAD_ONLY",
  });
  const approver = createUser({
    name: "Approver",
    email: `approver-${filename}-${Date.now()}@example.com`,
    password: "password123",
    role: "APPROVE_ONLY",
  });

  fs.writeFileSync(path.join(uploadDir, filename), "content");
  const doc = createDocument({
    originalFilename: filename,
    storedFilename: filename,
    mimeType: "application/pdf",
    sizeBytes: 7,
    uploaderId: uploader.id,
  });
  rejectDocument(doc.id, approver.id, "test rejection");
  db.prepare(`UPDATE documents SET rejected_at = datetime('now', ?) WHERE id = ?`).run(
    `-${daysAgo} days`,
    doc.id
  );
  return doc.id;
}

describe("purgeExpiredRejectedDocuments", () => {
  it("purges a document rejected more than the retention window ago", () => {
    const oldId = makeRejectedDoc("old.pdf", 45);

    const purged = purgeExpiredRejectedDocuments(uploadDir, 30);

    expect(purged.map((d) => d.id)).toEqual([oldId]);
    expect(getDocumentRow(oldId)).toBeUndefined();
    expect(fs.existsSync(path.join(uploadDir, "old.pdf"))).toBe(false);
  });

  it("leaves a document rejected within the retention window alone", () => {
    const recentId = makeRejectedDoc("recent.pdf", 5);

    const purged = purgeExpiredRejectedDocuments(uploadDir, 30);

    expect(purged).toHaveLength(0);
    expect(getDocumentRow(recentId)).toBeDefined();
    expect(fs.existsSync(path.join(uploadDir, "recent.pdf"))).toBe(true);
  });

  it("only touches REJECTED documents - UPLOADED and ACKNOWLEDGED are never purged regardless of age", () => {
    const uploader = createUser({
      name: "Uploader",
      email: `uploader-${Date.now()}@example.com`,
      password: "password123",
      role: "UPLOAD_ONLY",
    });
    fs.writeFileSync(path.join(uploadDir, "pending.pdf"), "content");
    const pending = createDocument({
      originalFilename: "pending.pdf",
      storedFilename: "pending.pdf",
      mimeType: "application/pdf",
      sizeBytes: 7,
      uploaderId: uploader.id,
    });
    // Even if created_at were somehow ancient, there's no rejected_at to
    // compare against, so it must never match the purge query.
    db.prepare(`UPDATE documents SET created_at = datetime('now', '-999 days') WHERE id = ?`).run(pending.id);

    const purged = purgeExpiredRejectedDocuments(uploadDir, 30);

    expect(purged).toHaveLength(0);
    expect(getDocumentRow(pending.id)).toBeDefined();
  });

  it("does not throw if the file on disk is already missing", () => {
    const oldId = makeRejectedDoc("gone.pdf", 45);
    fs.unlinkSync(path.join(uploadDir, "gone.pdf")); // simulate already-deleted file

    expect(() => purgeExpiredRejectedDocuments(uploadDir, 30)).not.toThrow();
    expect(getDocumentRow(oldId)).toBeUndefined();
  });
});
