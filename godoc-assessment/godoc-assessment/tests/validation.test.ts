import { validateUpload } from "../src/lib/validation";

describe("validateUpload", () => {
  it("accepts an allowed mime type within the size limit", () => {
    const result = validateUpload({
      mimeType: "application/pdf",
      sizeBytes: 1024,
      originalFilename: "consult-notes.pdf",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a disallowed mime type", () => {
    const result = validateUpload({
      mimeType: "application/x-msdownload",
      sizeBytes: 1024,
      originalFilename: "malware.exe",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not allowed/);
  });

  it("rejects a file over the configured size limit", () => {
    const maxBytes = Number(process.env.MAX_FILE_SIZE_MB) * 1024 * 1024;
    const result = validateUpload({
      mimeType: "application/pdf",
      sizeBytes: maxBytes + 1,
      originalFilename: "huge.pdf",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/exceeds/);
  });

  it("rejects an empty file", () => {
    const result = validateUpload({
      mimeType: "application/pdf",
      sizeBytes: 0,
      originalFilename: "empty.pdf",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/empty/);
  });

  it("rejects a missing filename", () => {
    const result = validateUpload({
      mimeType: "application/pdf",
      sizeBytes: 1024,
      originalFilename: "",
    });
    expect(result.valid).toBe(false);
  });
});
