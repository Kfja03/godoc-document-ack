export type Role = "UPLOAD_ONLY" | "APPROVE_ONLY" | "UPLOAD_AND_APPROVE";

export function canUpload(role: Role): boolean {
  return role === "UPLOAD_ONLY" || role === "UPLOAD_AND_APPROVE";
}

export function canApprove(role: Role): boolean {
  return role === "APPROVE_ONLY" || role === "UPLOAD_AND_APPROVE";
}
