import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { DocumentRecord } from "./api";
import {
  acknowledgeDocument,
  downloadUrl,
  listDocuments,
  rejectDocument,
  uploadDocument,
} from "./api";

function StatusBadge({ status }: { status: DocumentRecord["status"] }) {
  const className =
    status === "ACKNOWLEDGED" ? "badge badge-ack" : status === "REJECTED" ? "badge badge-rej" : "badge badge-pending";
  return <span className={className}>{status}</span>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploaderName, setUploaderName] = useState("");
  const [intendedRecipient, setIntendedRecipient] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const [actorById, setActorById] = useState<Record<string, string>>({});
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    try {
      setDocuments(await listDocuments());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (!file || !uploaderName || !intendedRecipient) return;
    setUploading(true);
    setError(null);
    try {
      await uploadDocument(file, uploaderName, intendedRecipient);
      setFile(null);
      (document.getElementById("file-input") as HTMLInputElement).value = "";
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleAcknowledge(doc: DocumentRecord) {
    const actor = actorById[doc.id]?.trim();
    if (!actor) {
      setError("Enter your name before acknowledging.");
      return;
    }
    setBusyId(doc.id);
    setError(null);
    try {
      await acknowledgeDocument(doc.id, actor);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(doc: DocumentRecord) {
    const actor = actorById[doc.id]?.trim();
    if (!actor) {
      setError("Enter your name before rejecting.");
      return;
    }
    setBusyId(doc.id);
    setError(null);
    try {
      await rejectDocument(doc.id, actor, reasonById[doc.id] || "");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Document Upload &amp; Acknowledgement</h1>
        <p className="subtitle">GoDoc take-home assessment - consultation-related document flow</p>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <section className="card">
        <h2>Upload a document</h2>
        <form onSubmit={handleUpload} className="upload-form">
          <label>
            Your name (uploader)
            <input value={uploaderName} onChange={(e) => setUploaderName(e.target.value)} required />
          </label>
          <label>
            Intended recipient
            <input
              value={intendedRecipient}
              onChange={(e) => setIntendedRecipient(e.target.value)}
              required
            />
          </label>
          <label>
            File (PDF, PNG, JPG, DOC, DOCX - max 10MB)
            <input
              id="file-input"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
          </label>
          <button type="submit" disabled={uploading}>
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Documents</h2>
        {loading ? (
          <p>Loading...</p>
        ) : documents.length === 0 ? (
          <p>No documents uploaded yet.</p>
        ) : (
          <ul className="doc-list">
            {documents.map((doc) => (
              <li key={doc.id} className="doc-item">
                <div className="doc-header">
                  <a href={downloadUrl(doc.id)}>{doc.original_filename}</a>
                  <StatusBadge status={doc.status} />
                </div>
                <div className="doc-meta">
                  {formatBytes(doc.size_bytes)} - uploaded by {doc.uploader_name} for{" "}
                  {doc.intended_recipient} on {doc.created_at}
                </div>
                {doc.status === "ACKNOWLEDGED" && (
                  <div className="doc-meta">Acknowledged by {doc.acknowledged_by} at {doc.acknowledged_at}</div>
                )}
                {doc.status === "REJECTED" && (
                  <div className="doc-meta">
                    Rejected by {doc.rejected_by} at {doc.rejected_at}
                    {doc.rejection_reason ? ` - "${doc.rejection_reason}"` : ""}
                  </div>
                )}
                {doc.status === "UPLOADED" && (
                  <div className="doc-actions">
                    <input
                      placeholder="Your name"
                      value={actorById[doc.id] || ""}
                      onChange={(e) => setActorById((s) => ({ ...s, [doc.id]: e.target.value }))}
                    />
                    <input
                      placeholder="Rejection reason (optional)"
                      value={reasonById[doc.id] || ""}
                      onChange={(e) => setReasonById((s) => ({ ...s, [doc.id]: e.target.value }))}
                    />
                    <button disabled={busyId === doc.id} onClick={() => handleAcknowledge(doc)}>
                      Acknowledge
                    </button>
                    <button
                      className="secondary"
                      disabled={busyId === doc.id}
                      onClick={() => handleReject(doc)}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
