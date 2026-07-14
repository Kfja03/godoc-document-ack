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

describe("request-revision / resubmit workflow", () => {
  it("an approver can request revision on an UPLOADED document instead of a flat reject", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = await upload(uploader.agent);

    const res = await approver.agent
      .post(`/api/documents/${doc.id}/request-revision`)
      .send({ note: "Please attach the signed consent page too." });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("NEEDS_REVISION");
    expect(res.body.revision_note).toBe("Please attach the signed consent page too.");
    expect(res.body.revision_requested_by_id).toBe(approver.user.id);
  });

  it("cannot request revision on a document that isn't UPLOADED", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = await upload(uploader.agent);
    await approver.agent.post(`/api/documents/${doc.id}/acknowledge`);

    const res = await approver.agent.post(`/api/documents/${doc.id}/request-revision`);
    expect(res.status).toBe(409);
  });

  it("UPLOAD_ONLY cannot request revision - it's an approval-capability action", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const doc = await upload(uploader.agent);

    const res = await uploader.agent.post(`/api/documents/${doc.id}/request-revision`);
    expect(res.status).toBe(403);
  });

  it("the original uploader can resubmit a corrected file, which moves the document back to UPLOADED", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = await upload(uploader.agent, "v1.pdf");
    await approver.agent.post(`/api/documents/${doc.id}/request-revision`).send({ note: "fix this" });

    const res = await uploader.agent
      .post(`/api/documents/${doc.id}/resubmit`)
      .attach("file", pdfFixture, { filename: "v2-corrected.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("UPLOADED");
    expect(res.body.original_filename).toBe("v2-corrected.pdf");
    expect(res.body.revision_requested_at).toBeNull();
    expect(res.body.revision_note).toBeNull();
  });

  it("a different uploader (not the doc's owner, not a lead) cannot resubmit someone else's document", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const otherUploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = await upload(uploader.agent);
    await approver.agent.post(`/api/documents/${doc.id}/request-revision`);

    const res = await otherUploader.agent
      .post(`/api/documents/${doc.id}/resubmit`)
      .attach("file", pdfFixture, { filename: "v2.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
  });

  it("a lead can resubmit on behalf of any uploader", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");
    const doc = await upload(uploader.agent);
    await approver.agent.post(`/api/documents/${doc.id}/request-revision`);

    const res = await lead.agent
      .post(`/api/documents/${doc.id}/resubmit`)
      .attach("file", pdfFixture, { filename: "fixed-by-lead.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("UPLOADED");
  });

  it("cannot resubmit a document that isn't in NEEDS_REVISION", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const doc = await upload(uploader.agent);

    const res = await uploader.agent
      .post(`/api/documents/${doc.id}/resubmit`)
      .attach("file", pdfFixture, { filename: "v2.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(409);
  });

  it("a document in NEEDS_REVISION remains visible to its own uploader (own-document visibility rule)", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = await upload(uploader.agent);
    await approver.agent.post(`/api/documents/${doc.id}/request-revision`);

    const list = await uploader.agent.get("/api/documents");
    expect(list.body.map((d: { id: string }) => d.id)).toContain(doc.id);
  });
});
