import request from "supertest";
import { createApp } from "../src/app";
import { loginAs } from "./helpers";
import db from "../src/db";

const app = createApp();
const pdfFixture = Buffer.from("%PDF-1.4 fake content for testing");

beforeEach(() => {
  db.exec("DELETE FROM documents");
  db.exec("DELETE FROM users");
});

async function upload(agent: ReturnType<typeof request.agent>, filename = "notes.pdf") {
  const res = await agent
    .post("/api/documents")
    .attach("file", pdfFixture, { filename, contentType: "application/pdf" });
  return res.body;
}

describe("manage capability (edit + delete)", () => {
  it("UPLOAD_ONLY cannot delete or edit any document", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const doc = await upload(uploader.agent);

    const del = await uploader.agent.delete(`/api/documents/${doc.id}`);
    expect(del.status).toBe(403);

    const edit = await uploader.agent
      .patch(`/api/documents/${doc.id}`)
      .attach("file", pdfFixture, { filename: "v2.pdf", contentType: "application/pdf" });
    expect(edit.status).toBe(403);
  });

  it("APPROVE_ONLY cannot delete or edit either - manage is lead-only, not approve-only", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = await upload(uploader.agent);

    const del = await approver.agent.delete(`/api/documents/${doc.id}`);
    expect(del.status).toBe(403);

    const edit = await approver.agent
      .patch(`/api/documents/${doc.id}`)
      .attach("file", pdfFixture, { filename: "v2.pdf", contentType: "application/pdf" });
    expect(edit.status).toBe(403);
  });

  it("UPLOAD_AND_APPROVE (lead) can delete another user's document", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");
    const doc = await upload(uploader.agent);

    const del = await lead.agent.delete(`/api/documents/${doc.id}`);
    expect(del.status).toBe(204);

    const get = await lead.agent.get(`/api/documents/${doc.id}`);
    expect(get.status).toBe(404);
  });

  it("delete is a soft delete: the row and file survive, just hidden from every read path", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");
    const doc = await upload(uploader.agent, "soft-me.pdf");

    await lead.agent.delete(`/api/documents/${doc.id}`);

    // Hidden from list for every role, not just the uploader.
    const uploaderList = await uploader.agent.get("/api/documents");
    expect(uploaderList.body.map((d: { id: string }) => d.id)).not.toContain(doc.id);
    const leadList = await lead.agent.get("/api/documents");
    expect(leadList.body.map((d: { id: string }) => d.id)).not.toContain(doc.id);

    // But the row (with deleted_at set) and the file are both still there
    // at the DB/disk level - only the retention sweep removes them for
    // real. Checked via the internal helper, not the API (which correctly
    // treats it as gone).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDocumentRow } = require("../src/lib/documents");
    const raw = getDocumentRow(doc.id);
    expect(raw).toBeDefined();
    expect(raw.deleted_at).not.toBeNull();
  });

  it("deleting an already soft-deleted document returns 404 (can't double-delete)", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");
    const doc = await upload(uploader.agent);
    await lead.agent.delete(`/api/documents/${doc.id}`);

    const res = await lead.agent.delete(`/api/documents/${doc.id}`);
    expect(res.status).toBe(404);
  });

  it("deleting a document that doesn't exist returns 404", async () => {
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");
    const res = await lead.agent.delete(`/api/documents/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("lead editing an acknowledged document replaces the file and resets it to UPLOADED", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");

    const doc = await upload(uploader.agent, "v1.pdf");
    await approver.agent.post(`/api/documents/${doc.id}/acknowledge`);

    const edited = await lead.agent
      .patch(`/api/documents/${doc.id}`)
      .attach("file", pdfFixture, { filename: "v2-corrected.pdf", contentType: "application/pdf" });

    expect(edited.status).toBe(200);
    expect(edited.body.original_filename).toBe("v2-corrected.pdf");
    expect(edited.body.status).toBe("UPLOADED");
    expect(edited.body.acknowledged_at).toBeNull();
    expect(edited.body.acknowledged_by_id).toBeNull();
  });

  it("editing a document that doesn't exist returns 404", async () => {
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");
    const res = await lead.agent
      .patch(`/api/documents/does-not-exist`)
      .attach("file", pdfFixture, { filename: "v2.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(404);
  });

  it("editing with an invalid file type is rejected the same way as a fresh upload", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");
    const doc = await upload(uploader.agent);

    const res = await lead.agent
      .patch(`/api/documents/${doc.id}`)
      .attach("file", Buffer.from("MZ"), { filename: "bad.exe", contentType: "application/x-msdownload" });
    expect(res.status).toBe(400);
  });
});
