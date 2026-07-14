import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import type { DocumentRecord } from "./api";
import {
  acknowledgeDocument,
  downloadUrl,
  listDocuments,
  rejectDocument,
  uploadDocument,
} from "./api";

type Filter = "ALL" | "UPLOADED" | "ACKNOWLEDGED" | "REJECTED";

function StatusBadge({ status }: { status: DocumentRecord["status"] }) {
  const className =
    status === "ACKNOWLEDGED"
      ? "badge badge-ack"
      : status === "REJECTED"
      ? "badge badge-rej"
      : "badge badge-pending";
  const label =
    status === "ACKNOWLEDGED" ? "Acknowledged" : status === "REJECTED" ? "Rejected" : "Awaiting review";
  return (
    <span className={className}>
      <span className="badge-dot" />
      {label}
    </span>
  );
}

function fileKindIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.includes("word")) return "📝";
  return "📎";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(iso: string): string {
  const then = new Date(iso.replace(" ", "T") + "Z").getTime();
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function App() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");

  const [uploaderName, setUploaderName] = useState("");
  const [intendedRecipient, setIntendedRecipient] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const counts = useMemo(() => {
    return {
      ALL: documents.length,
      UPLOADED: documents.filter((d) => d.status === "UPLOADED").length,
      ACKNOWLEDGED: documents.filter((d) => d.status === "ACKNOWLEDGED").length,
      REJECTED: documents.filter((d) => d.status === "REJECTED").length,
    };
  }, [documents]);

  const visibleDocuments = useMemo(
    () => (filter === "ALL" ? documents : documents.filter((d) => d.status === filter)),
    [documents, filter]
  );

  function pickFile(f: File | null) {
    setFile(f);
    setError(null);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) pickFile(dropped);
  }

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (!file || !uploaderName || !intendedRecipient) return;
    setUploading(true);
    setError(null);
    try {
      await uploadDocument(file, uploaderName, intendedRecipient);
      pickFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

  const filters: { key: Filter; label: string }[] = [
    { key: "ALL", label: "All" },
    { key: "UPLOADED", label: "Awaiting review" },
    { key: "ACKNOWLEDGED", label: "Acknowledged" },
    { key: "REJECTED", label: "Rejected" },
  ];

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">GD</span>
          <div>
            <h1>Document Upload &amp; Acknowledgement</h1>
            <p className="subtitle">Consultation-related document flow</p>
          </div>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="layout">
        <aside className="panel upload-panel">
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

            <label>File</label>
            <div
              className={`dropzone ${dragActive ? "dropzone-active" : ""} ${file ? "dropzone-filled" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              {file ? (
                <>
                  <span className="dropzone-icon">{fileKindIcon(file.type)}</span>
                  <span className="dropzone-title">{file.name}</span>
                  <span className="dropzone-hint">{formatBytes(file.size)} - click or drop to replace</span>
                </>
              ) : (
                <>
                  <span className="dropzone-icon">⬆️</span>
                  <span className="dropzone-title">Drag & drop a file here</span>
                  <span className="dropzone-hint">or click to browse - PDF, PNG, JPG, DOC, DOCX, max 10MB</span>
                </>
              )}
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </div>

            <button type="submit" disabled={uploading || !file} className="primary-btn">
              {uploading ? (
                <>
                  <span className="spinner" /> Uploading...
                </>
              ) : (
                "Upload document"
              )}
            </button>
          </form>
        </aside>

        <main className="panel documents-panel">
          <div className="documents-header">
            <h2>Documents</h2>
            <div className="filter-row">
              {filters.map((f) => (
                <button
                  key={f.key}
                  className={`chip ${filter === f.key ? "chip-active" : ""}`}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  <span className="chip-count">{counts[f.key]}</span>
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="skeleton-grid">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton-card" />
              ))}
            </div>
          ) : visibleDocuments.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">🗂️</span>
              <p>{documents.length === 0 ? "No documents uploaded yet." : "Nothing in this filter."}</p>
            </div>
          ) : (
            <div className="doc-grid">
              {visibleDocuments.map((doc) => (
                <article key={doc.id} className={`doc-card doc-card-${doc.status.toLowerCase()}`}>
                  <div className="doc-card-top">
                    <span className="doc-file-icon">{fileKindIcon(doc.mime_type)}</span>
                    <div className="doc-title-block">
                      <a href={downloadUrl(doc.id)} className="doc-name">
                        {doc.original_filename}
                      </a>
                      <span className="doc-size">{formatBytes(doc.size_bytes)}</span>
                    </div>
                    <StatusBadge status={doc.status} />
                  </div>

                  <div className="doc-meta-row">
                    <span>
                      {doc.uploader_name} → {doc.intended_recipient}
                    </span>
                    <span className="doc-time">{timeAgo(doc.created_at)}</span>
                  </div>

                  {doc.status === "ACKNOWLEDGED" && (
                    <div className="doc-outcome doc-outcome-ack">
                      Acknowledged by <strong>{doc.acknowledged_by}</strong> - {timeAgo(doc.acknowledged_at!)}
                    </div>
                  )}
                  {doc.status === "REJECTED" && (
                    <div className="doc-outcome doc-outcome-rej">
                      Rejected by <strong>{doc.rejected_by}</strong> - {timeAgo(doc.rejected_at!)}
                      {doc.rejection_reason ? <div className="doc-reason">"{doc.rejection_reason}"</div> : null}
                    </div>
                  )}

                  {doc.status === "UPLOADED" && (
                    <div className="doc-actions">
                      <input
                        className="doc-actions-input"
                        placeholder="Your name"
                        value={actorById[doc.id] || ""}
                        onChange={(e) => setActorById((s) => ({ ...s, [doc.id]: e.target.value }))}
                      />
                      <input
                        className="doc-actions-input"
                        placeholder="Rejection reason (optional)"
                        value={reasonById[doc.id] || ""}
                        onChange={(e) => setReasonById((s) => ({ ...s, [doc.id]: e.target.value }))}
                      />
                      <div className="doc-actions-buttons">
                        <button
                          className="ack-btn"
                          disabled={busyId === doc.id}
                          onClick={() => handleAcknowledge(doc)}
                        >
                          {busyId === doc.id ? <span className="spinner" /> : "✓ Acknowledge"}
                        </button>
                        <button
                          className="rej-btn"
                          disabled={busyId === doc.id}
                          onClick={() => handleReject(doc)}
                        >
                          ✕ Reject
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
