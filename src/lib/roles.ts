export type Role = "UPLOAD_ONLY" | "APPROVE_ONLY" | "UPLOAD_AND_APPROVE";

export function canUpload(role: Role): boolean {
  return role === "UPLOAD_ONLY" || role === "UPLOAD_AND_APPROVE";
}

export function canApprove(role: Role): boolean {
  return role === "APPROVE_ONLY" || role === "UPLOAD_AND_APPROVE";
}

// "Lead" capability: edit (replace file) or permanently delete ANY
// document, regardless of who uploaded it. Deliberately restricted to
// UPLOAD_AND_APPROVE only - not just "anyone who can approve" - since
// destructive/corrective actions on someone else's document are a bigger
// deal than approving it, and in the seed data this role is literally
// named "Lead Consultant".
export function canManage(role: Role): boolean {
  return role === "UPLOAD_AND_APPROVE";
}
