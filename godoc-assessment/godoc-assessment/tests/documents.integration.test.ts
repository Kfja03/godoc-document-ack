import request from "supertest";
import path from "path";
import { createApp } from "../src/app";

const app = createApp();

const pdfFixture = Buffer.from("%PDF-1.4 fake content for testing");

describe("POST /api/documents (upload)", () => {
  it("uploads a valid PDF and returns it in UPLOADED status", async () => {
    const res = await request(app)
      .post("/api/documents")
      .field("uploaderName", "Alice")
      .field("intendedRecipient", "Bob")
      .attach("file", pdfFixture, { filename: "notes.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("UPLOADED");
    expect(res.body.original_filename).toBe("notes.pdf");
  });

  it("rejects a disallowed file type with 400", async () => {
    const res = await request(app)
      .post("/api/documents")
      .field("uploaderName", "Alice")
      .field("intendedRecipient", "Bob")
      .attach("file", Buffer.from("MZ fake exe"), {
        filename: "malware.exe",
        contentType: "application/x-msdownload",
      });

    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatch(/not allowed/);
  });

  it("rejects a file over the size limit with 400", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024); // limit is 1MB in test env
    const res = await request(app)
      .post("/api/documents")
      .field("uploaderName", "Alice")
      .field("intendedRecipient", "Bob")
      .attach("file", big, { filename: "big.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
  });

  it("requires uploaderName and intendedRecipient", async () => {
    const res = await request(app)
      .post("/api/documents")
      .attach("file", pdfFixture, { filename: "notes.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
  });
});

describe("document lifecycle", () => {
  async function uploadDoc() {
    const res = await request(app)
      .post("/api/documents")
      .field("uploaderName", "Alice")
      .field("intendedRecipient", "Bob")
      .attach("file", pdfFixture, { filename: "lifecycle.pdf", contentType: "application/pdf" });
    return res.body;
  }

  it("moves UPLOADED -> ACKNOWLEDGED and blocks a second acknowledge", async () => {
    const doc = await uploadDoc();

    const ack = await request(app)
      .post(`/api/documents/${doc.id}/acknowledge`)
      .send({ actor: "Bob" });
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe("ACKNOWLEDGED");
    expect(ack.body.acknowledged_by).toBe("Bob");

    const ackAgain = await request(app)
      .post(`/api/documents/${doc.id}/acknowledge`)
      .send({ actor: "Bob" });
    expect(ackAgain.status).toBe(409);
  });

  it("moves UPLOADED -> REJECTED with a reason, and blocks acknowledging afterwards", async () => {
    const doc = await uploadDoc();

    const rejected = await request(app)
      .post(`/api/documents/${doc.id}/reject`)
      .send({ actor: "Bob", reason: "Wrong document attached" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("REJECTED");
    expect(rejected.body.rejection_reason).toBe("Wrong document attached");

    const ackAfterReject = await request(app)
      .post(`/api/documents/${doc.id}/acknowledge`)
      .send({ actor: "Bob" });
    expect(ackAfterReject.status).toBe(409);
  });

  it("404s when acting on a document that does not exist", async () => {
    const res = await request(app)
      .post(`/api/documents/does-not-exist/acknowledge`)
      .send({ actor: "Bob" });
    expect(res.status).toBe(404);
  });

  // This is the key correctness test: two requests racing to act on the
  // same document (e.g. a double-click, or two tabs) must not both
  // "succeed" - exactly one should win, the other should see a 409. This
  // exercises the same atomic-update pattern that would be used to prevent
  // a double-booking in the booking-system option.
  it("only allows one of two concurrent acknowledge requests to succeed", async () => {
    const doc = await uploadDoc();

    const [first, second] = await Promise.all([
      request(app).post(`/api/documents/${doc.id}/acknowledge`).send({ actor: "Bob" }),
      request(app).post(`/api/documents/${doc.id}/acknowledge`).send({ actor: "Carol" }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
