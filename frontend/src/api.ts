export type Role = "UPLOAD_ONLY" | "APPROVE_ONLY" | "UPLOAD_AND_APPROVE";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  created_at: string;
}

export interface DocumentRecord {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  uploader_id: string;
  uploader_name: string;
  status: "UPLOADED" | "ACKNOWLEDGED" | "REJECTED";
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by_id: string | null;
  acknowledged_by_name: string | null;
  rejected_at: string | null;
  rejected_by_id: string | null;
  rejected_by_name: string | null;
  rejection_reason: string | null;
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

export function downloadUrl(id: string): string {
  return `/api/documents/${id}/download`;
}
