export interface DocumentRecord {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  uploader_name: string;
  intended_recipient: string;
  status: "UPLOADED" | "ACKNOWLEDGED" | "REJECTED";
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
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

export async function listDocuments(): Promise<DocumentRecord[]> {
  const res = await fetch("/api/documents");
  return parseJsonOrThrow<DocumentRecord[]>(res);
}

export async function uploadDocument(
  file: File,
  uploaderName: string,
  intendedRecipient: string
): Promise<DocumentRecord> {
  const form = new FormData();
  form.append("file", file);
  form.append("uploaderName", uploaderName);
  form.append("intendedRecipient", intendedRecipient);
  const res = await fetch("/api/documents", { method: "POST", body: form });
  return parseJsonOrThrow<DocumentRecord>(res);
}

export async function acknowledgeDocument(id: string, actor: string): Promise<DocumentRecord> {
  const res = await fetch(`/api/documents/${id}/acknowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor }),
  });
  return parseJsonOrThrow<DocumentRecord>(res);
}

export async function rejectDocument(
  id: string,
  actor: string,
  reason: string
): Promise<DocumentRecord> {
  const res = await fetch(`/api/documents/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor, reason }),
  });
  return parseJsonOrThrow<DocumentRecord>(res);
}

export function downloadUrl(id: string): string {
  return `/api/documents/${id}/download`;
}
