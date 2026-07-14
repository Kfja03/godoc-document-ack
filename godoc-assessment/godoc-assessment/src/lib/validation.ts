export interface UploadValidationInput {
  mimeType: string;
  sizeBytes: number;
  originalFilename: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const DEFAULT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

function getAllowedMimeTypes(): string[] {
  const fromEnv = process.env.ALLOWED_MIME_TYPES;
  if (!fromEnv) return DEFAULT_ALLOWED_MIME_TYPES;
  return fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
}

function getMaxFileSizeBytes(): number {
  const mb = Number(process.env.MAX_FILE_SIZE_MB || 10);
  return mb * 1024 * 1024;
}

export function validateUpload(input: UploadValidationInput): ValidationResult {
  const errors: string[] = [];
  const allowedTypes = getAllowedMimeTypes();
  const maxBytes = getMaxFileSizeBytes();

  if (!input.originalFilename || input.originalFilename.trim().length === 0) {
    errors.push("File must have a filename.");
  }

  if (!allowedTypes.includes(input.mimeType)) {
    errors.push(
      `File type "${input.mimeType}" is not allowed. Allowed types: ${allowedTypes.join(", ")}`
    );
  }

  if (input.sizeBytes <= 0) {
    errors.push("File is empty.");
  } else if (input.sizeBytes > maxBytes) {
    errors.push(
      `File size ${(input.sizeBytes / (1024 * 1024)).toFixed(2)}MB exceeds the ${(
        maxBytes / (1024 * 1024)
      ).toFixed(0)}MB limit.`
    );
  }

  return { valid: errors.length === 0, errors };
}
