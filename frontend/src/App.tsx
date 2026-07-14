import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import type { CurrentUser, DocumentRecord } from "./api";
import {
  acknowledgeDocument,
  canApprove,
  canManage,
  canUpload,
  deleteDocument,
  downloadUrl,
  editDocument,
  fetchCurrentUser,
  listDocuments,
  logout,
  rejectDocument,
  uploadDocument,
} from "./api";
import Login from "./Login";

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

function RoleTag({ role }: { role: CurrentUser["role"] }) {
  const label =
    role === "UPLOAD_ONLY" ? "Upload only" : role === "APPROVE_ONLY" ? "Approve only" : "Upload & approve";
  return <span className="role-tag">{label}</span>;
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

// Mirrors the backend default (REJECTED_RETENTION_DAYS in .env, default
// 30) purely for display - if that env var is changed, this countdown
// would need to be passed down from the API instead of assumed here.
const RETENTION_DAYS = 30;

function daysUntilPurge(rejectedAtIso: string): number {
  const rejectedAt = new Date(rejectedAtIso.replace(" ", "T") + "Z").getTime();
  const purgeAt = rejectedAt + RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000));
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
  // undefined = still checking session, null = not logged in
  const [currentUser, setCurrentUser] = useState<CurrentUser | null | undefined>(undefined);

  useEffect(() => {
    fetchCurrentUser().then(setCurrentUser);
  }, []);

  if (currentUser === undefined) {
    return (
      <div className="boot-screen">
        <span className="spinner spinner-dark" />
      </div>
    );
  }

  if (currentUser === null) {
    return <Login onLogin={setCurrentUser} />;
  }

  return <Workspace user={currentUser} onLogout={() => setCurrentUser(null)} />;
}

function Workspace({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const editInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  async function refresh() {
    try {
      setDocuments(
        await listDocuments({
          status: filter === "ALL" ? undefined : filter,
          search: search || undefined,
        })
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(refresh, search ? 250 : 0); // light debounce on search typing
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, search]);

  const counts = useMemo(() => {
    return {
      ALL: documents.length,
      UPLOADED: documents.filter((d) => d.status === "UPLOADED").length,
      ACKNOWLEDGED: documents.filter((d) => d.status === "ACKNOWLEDGED").length,
      REJECTED: documents.filter((d) => d.status === "REJECTED").length,
    };
  }, [documents]);

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
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadDocument(file);
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
    setBusyId(doc.id);
    setError(null);
    try {
      await acknowledgeDocument(doc.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(doc: DocumentRecord) {
    setBusyId(doc.id);
    setError(null);
    try {
      await rejectDocument(doc.id, reasonById[doc.id] || "");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(doc: DocumentRecord) {
    if (!window.confirm(`Permanently delete "${doc.original_filename}"? This cannot be undone.`)) {
      return;
    }
    setBusyId(doc.id);
    setError(null);
    try {
      await deleteDocument(doc.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleEditFileChange(doc: DocumentRecord, newFile: File | undefined) {
    if (!newFile) return;
    setBusyId(doc.id);
    setError(null);
    try {
      await editDocument(doc.id, newFile);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
      const input = editInputRefs.current.get(doc.id);
      if (input) input.value = "";
    }
  }

  async function handleLogout() {
    await logout();
    onLogout();
  }

  const filters: { key: Filter; label: string }[] = [
    { key: "ALL", label: "All" },
    { key: "UPLOADED", label: "Awaiting review" },
    { key: "ACKNOWLEDGED", label: "Acknowledged" },
    { key: "REJECTED", label: "Rejected" },
  ];

  const showUpload = canUpload(user.role);
  const showApprove = canApprove(user.role);
  const showManage = canManage(user.role);

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
        <div className="user-block">
          <div className="user-identity">
            <span className="user-name">{user.name}</span>
            <RoleTag role={user.role} />
          </div>
          <button className="logout-btn" onClick={handleLogout}>
            Sign out
          </button>
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

      <div className={`layout ${showUpload ? "" : "layout-no-upload"}`}>
        {showUpload && (
          <aside className="panel upload-panel">
            <h2>Upload a document</h2>
            <form onSubmit={handleUpload} className="upload-form">
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
              <p className="upload-note">Uploaded as {user.name}. Any approver can review it.</p>
            </form>
          </aside>
        )}

        <main className="panel documents-panel">
          <div className="documents-header">
            <h2>Documents</h2>
            <input
              className="search-input"
              placeholder="Search by filename..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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

          {!showApprove && (
            <p className="scope-note">
              Showing your own documents plus every acknowledged document from other consultants.
            </p>
          )}

          {loading ? (
            <div className="skeleton-grid">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton-card" />
              ))}
            </div>
          ) : documents.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">🗂️</span>
              <p>{search ? "No documents match your search." : "No documents to show yet."}</p>
            </div>
          ) : (
            <div className="doc-grid">
              {documents.map((doc) => (
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
                      Uploaded by <strong>{doc.uploader_name}</strong>
                      {doc.uploader_id === user.id ? " (you)" : ""}
                    </span>
                    <span className="doc-time">{timeAgo(doc.created_at)}</span>
                  </div>

                  {doc.status === "ACKNOWLEDGED" && (
                    <div className="doc-outcome doc-outcome-ack">
                      Acknowledged by <strong>{doc.acknowledged_by_name}</strong> - {timeAgo(doc.acknowledged_at!)}
                    </div>
                  )}
                  {doc.status === "REJECTED" && (
                    <div className="doc-outcome doc-outcome-rej">
                      Rejected by <strong>{doc.rejected_by_name}</strong> - {timeAgo(doc.rejected_at!)}
                      {doc.rejection_reason ? <div className="doc-reason">"{doc.rejection_reason}"</div> : null}
                      <div className="purge-countdown">
                        {daysUntilPurge(doc.rejected_at!) > 0
                          ? `Auto-deletes in ${daysUntilPurge(doc.rejected_at!)} day${
                              daysUntilPurge(doc.rejected_at!) === 1 ? "" : "s"
                            }`
                          : "Queued for automatic deletion"}
                      </div>
                    </div>
                  )}

                  {doc.status === "UPLOADED" && showApprove && (
                    <div className="doc-actions">
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

                  {doc.status === "UPLOADED" && !showApprove && (
                    <div className="doc-outcome doc-outcome-pending">Waiting on an approver</div>
                  )}

                  {showManage && (
                    <div className="manage-actions">
                      <input
                        ref={(el) => {
                          if (el) editInputRefs.current.set(doc.id, el);
                          else editInputRefs.current.delete(doc.id);
                        }}
                        className="visually-hidden"
                        type="file"
                        onChange={(e) => handleEditFileChange(doc, e.target.files?.[0])}
                      />
                      <button
                        className="manage-btn"
                        disabled={busyId === doc.id}
                        onClick={() => editInputRefs.current.get(doc.id)?.click()}
                        title="Replace the file - resets this document to Awaiting review"
                      >
                        ✎ Edit
                      </button>
                      <button
                        className="manage-btn manage-btn-danger"
                        disabled={busyId === doc.id}
                        onClick={() => handleDelete(doc)}
                      >
                        🗑 Delete
                      </button>
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
