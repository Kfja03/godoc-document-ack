import request from "supertest";
import { createApp } from "../src/app";
import { loginAs } from "./helpers";
import db from "../src/db";

const app = createApp();

// Every test gets a clean slate. Tests share one SQLite file per test
// *file* (see tests/setupEnv.ts), so without this, documents/users created
// by one test - especially ACKNOWLEDGED documents, which are visible to
// everyone - would leak into the next test's assertions.
beforeEach(() => {
  db.exec("DELETE FROM documents");
  db.exec("DELETE FROM users");
});
const pdfFixture = Buffer.from("%PDF-1.4 fake content for testing");

async function upload(agent: ReturnType<typeof request.agent>, filename = "notes.pdf") {
  const res = await agent
    .post("/api/documents")
    .attach("file", pdfFixture, { filename, contentType: "application/pdf" });
  return res;
}

describe("authentication", () => {
  it("rejects requests to /api/documents with no session", async () => {
    const res = await request(app).get("/api/documents");
    expect(res.status).toBe(401);
  });

  it("logs in with correct credentials and rejects wrong password", async () => {
    const { user } = await loginAs(app, "UPLOAD_ONLY");

    const bad = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "wrong-password" });
    expect(bad.status).toBe(401);

    const good = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "password123" });
    expect(good.status).toBe(200);
    expect(good.body.user.email).toBe(user.email);
    // password hash must never be exposed
    expect(good.body.user.password_hash).toBeUndefined();
  });

  it("/api/auth/me reflects the logged-in user", async () => {
    const { agent, user } = await loginAs(app, "APPROVE_ONLY");
    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });
});

describe("upload capability", () => {
  it("UPLOAD_ONLY can upload", async () => {
    const { agent } = await loginAs(app, "UPLOAD_ONLY");
    const res = await upload(agent);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("UPLOADED");
  });

  it("UPLOAD_AND_APPROVE can upload", async () => {
    const { agent } = await loginAs(app, "UPLOAD_AND_APPROVE");
    const res = await upload(agent);
    expect(res.status).toBe(201);
  });

  it("APPROVE_ONLY cannot upload", async () => {
    const { agent } = await loginAs(app, "APPROVE_ONLY");
    const res = await upload(agent);
    expect(res.status).toBe(403);
  });

  it("rejects a disallowed file type with 400", async () => {
    const { agent } = await loginAs(app, "UPLOAD_ONLY");
    const res = await agent
      .post("/api/documents")
      .attach("file", Buffer.from("MZ fake exe"), {
        filename: "malware.exe",
        contentType: "application/x-msdownload",
      });
    expect(res.status).toBe(400);
  });
});

describe("approval capability and lifecycle", () => {
  it("APPROVE_ONLY can acknowledge; UPLOAD_ONLY cannot", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = (await upload(uploader.agent)).body;

    const deniedAck = await uploader.agent.post(`/api/documents/${doc.id}/acknowledge`);
    expect(deniedAck.status).toBe(403);

    const ack = await approver.agent.post(`/api/documents/${doc.id}/acknowledge`);
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe("ACKNOWLEDGED");
    expect(ack.body.acknowledged_by_name).toBe(approver.user.name);
  });

  it("blocks a second acknowledge on the same document", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = (await upload(uploader.agent)).body;

    await approver.agent.post(`/api/documents/${doc.id}/acknowledge`);
    const again = await approver.agent.post(`/api/documents/${doc.id}/acknowledge`);
    expect(again.status).toBe(409);
  });

  it("rejects with a reason, and blocks acknowledging afterwards", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const doc = (await upload(uploader.agent)).body;

    const rejected = await approver.agent
      .post(`/api/documents/${doc.id}/reject`)
      .send({ reason: "Wrong document attached" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.rejection_reason).toBe("Wrong document attached");

    const ackAfter = await approver.agent.post(`/api/documents/${doc.id}/acknowledge`);
    expect(ackAfter.status).toBe(409);
  });

  it("404s when acting on a document that does not exist", async () => {
    const approver = await loginAs(app, "APPROVE_ONLY");
    const res = await approver.agent.post(`/api/documents/does-not-exist/acknowledge`);
    expect(res.status).toBe(404);
  });

  // Key correctness test: two approvers racing to act on the same document
  // must not both "succeed" - exactly one should win.
  it("only allows one of two concurrent acknowledge requests to succeed", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approverA = await loginAs(app, "APPROVE_ONLY");
    const approverB = await loginAs(app, "APPROVE_ONLY");
    const doc = (await upload(uploader.agent)).body;

    const [first, second] = await Promise.all([
      approverA.agent.post(`/api/documents/${doc.id}/acknowledge`),
      approverB.agent.post(`/api/documents/${doc.id}/acknowledge`),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe("document visibility", () => {
  it("UPLOAD_ONLY sees their own documents in any status, but not another uploader's pending/rejected docs", async () => {
    const uploaderA = await loginAs(app, "UPLOAD_ONLY", "Uploader A");
    const uploaderB = await loginAs(app, "UPLOAD_ONLY", "Uploader B");
    const approver = await loginAs(app, "APPROVE_ONLY");

    const ownPending = (await upload(uploaderA.agent, "own-pending.pdf")).body;
    const othersPending = (await upload(uploaderB.agent, "others-pending.pdf")).body;
    const othersApproved = (await upload(uploaderB.agent, "others-approved.pdf")).body;
    const othersRejected = (await upload(uploaderB.agent, "others-rejected.pdf")).body;

    await approver.agent.post(`/api/documents/${othersApproved.id}/acknowledge`);
    await approver.agent.post(`/api/documents/${othersRejected.id}/reject`).send({ reason: "no" });

    const list = await uploaderA.agent.get("/api/documents");
    const names = list.body.map((d: { original_filename: string }) => d.original_filename).sort();

    expect(names).toEqual(["others-approved.pdf", "own-pending.pdf"].sort());
    expect(names).not.toContain("others-pending.pdf");
    expect(names).not.toContain("others-rejected.pdf");

    // Direct access to a hidden document is also blocked, not just filtered
    // out of the list - visibility is enforced server-side per-document.
    const directGet = await uploaderA.agent.get(`/api/documents/${othersPending.id}`);
    expect(directGet.status).toBe(404);
    const directDownload = await uploaderA.agent.get(`/api/documents/${othersRejected.id}/download`);
    expect(directDownload.status).toBe(404);
  });

  it("APPROVE_ONLY and UPLOAD_AND_APPROVE see every document regardless of uploader or status", async () => {
    const uploaderA = await loginAs(app, "UPLOAD_ONLY", "Uploader A");
    const approver = await loginAs(app, "APPROVE_ONLY");
    const lead = await loginAs(app, "UPLOAD_AND_APPROVE");

    await upload(uploaderA.agent, "pending.pdf");
    const approved = (await upload(uploaderA.agent, "approved.pdf")).body;
    await approver.agent.post(`/api/documents/${approved.id}/acknowledge`);

    const approverList = await approver.agent.get("/api/documents");
    expect(approverList.body.length).toBe(2);

    const leadList = await lead.agent.get("/api/documents");
    expect(leadList.body.length).toBe(2);
  });

  it("supports filtering by status and searching by filename", async () => {
    const uploader = await loginAs(app, "UPLOAD_ONLY");
    const approver = await loginAs(app, "APPROVE_ONLY");

    const a = (await upload(uploader.agent, "quarterly-report.pdf")).body;
    await upload(uploader.agent, "consent-form.pdf");
    await approver.agent.post(`/api/documents/${a.id}/acknowledge`);

    const byStatus = await approver.agent.get("/api/documents?status=ACKNOWLEDGED");
    expect(byStatus.body.map((d: { original_filename: string }) => d.original_filename)).toEqual([
      "quarterly-report.pdf",
    ]);

    const bySearch = await approver.agent.get("/api/documents?search=consent");
    expect(bySearch.body.map((d: { original_filename: string }) => d.original_filename)).toEqual([
      "consent-form.pdf",
    ]);
  });
});
