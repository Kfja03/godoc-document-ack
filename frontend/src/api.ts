export type Role = "UPLOAD_ONLY" | "APPROVE_ONLY" | "UPLOAD_AND_APPROVE";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  created_at: string;
}

export type DocumentStatus = "UPLOADED" | "ACKNOWLEDGED" | "REJECTED" | "NEEDS_REVISION";

export interface DocumentRecord {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  uploader_id: string;
  uploader_name: string;
  status: DocumentStatus;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by_id: string | null;
  acknowledged_by_name: string | null;
  rejected_at: string | null;
  rejected_by_id: string | null;
  rejected_by_name: string | null;
  rejection_reason: string | null;
  revision_requested_at: string | null;
  revision_requested_by_id: string | null;
  revision_requested_by_name: string | null;
  revision_note: string | null;
}

export interface ApiError {
  errors?: string[];
  error?: string;
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body as ApiError;
    const message = err.errors?.join(" ") || err.error || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function canUpload(role: Role): boolean {
  return role === "UPLOAD_ONLY" || role === "UPLOAD_AND_APPROVE";
}

export function canApprove(role: Role): boolean {
  return role === "APPROVE_ONLY" || role === "UPLOAD_AND_APPROVE";
}

export function canManage(role: Role): boolean {
  return role === "UPLOAD_AND_APPROVE";
}

// --- auth ---

export async function login(email: string, password: string): Promise<CurrentUser> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await parseJsonOrThrow<{ user: CurrentUser }>(res);
  return body.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
}

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (res.status === 401) return null;
  const body = await parseJsonOrThrow<{ user: CurrentUser }>(res);
  return body.user;
}

// --- documents ---

export interface ListParams {
  status?: string;
  search?: string;
}

export async function listDocuments(params: ListParams = {}): Promise<DocumentRecord[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.search) qs.set("search", params.search);
  const query = qs.toString();
  const res = await fetch(`/api/documents${query ? `?${query}` : ""}`, { credentials: "include" });
  return parseJsonOrThrow<DocumentRecord[]>(res);
}

export async function uploadDocument(file: File): Promise<DocumentRecord> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/documents", { method: "POST", credentials: "include", body: form });
  return parseJsonOrThrow<DocumentRecord>(res);
}

export async function acknowledgeDocument(id: string): Promise<DocumentRecord> {
  const res = await fetch(`/api/documents/${id}/acknowledge`, {
    method: "POST",
    credentials: "include",
  });
  return parseJsonOrThrow<DocumentRecord>(res);
}

export async function rejectDocument(id: string, reason: string): Promise<DocumentRecord> {
  const res = await fetch(`/api/documents/${id}/reject`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  return parseJsonOrThrow<DocumentRecord>(res);
}

// "Send back for more info" - distinct from reject. Puts the document in
// NEEDS_REVISION; only the uploader (or a lead) can resolve it, via
// resubmitDocument below.
export async function requestRevisionDocument(id: string, note: string): Promise<DocumentRecord> {
  const res = await fetch(`/api/documents/${id}/request-revision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  return parseJsonOrThrow<DocumentRecord>(res);
}

// The uploader's response to a request-revision: a corrected file that
// sends the document back to UPLOADED for a fresh review.
export async function resubmitDocument(id: string, file: File): Promise<DocumentRecord> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/documents/${id}/resubmit`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  return parseJsonOrThrow<DocumentRecord>(res);
}

export async function editDocument(id: string, file: File): Promise<DocumentRecord> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/documents/${id}`, {
    method: "PATCH",
    credentials: "include",
    body: form,
  });
  return parseJsonOrThrow<DocumentRecord>(res);
}

// Soft delete - hides the document immediately; the row/file are removed
// for real later by the server's retention sweep (see README).
export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`/api/documents/${id}`, { method: "DELETE", credentials: "include" });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    const err = body as ApiError;
    throw new Error(err.error || `Request failed (${res.status})`);
  }
}

export function downloadUrl(id: string): string {
  return `/api/documents/${id}/download`;
}
