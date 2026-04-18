// Normalised representations returned by any source client

export interface DiscoveredCourse {
  externalId: string;
  name: string;
  courseCode: string | null;
  termId: string | null;
}

export interface DiscoveredFile {
  externalId: string;
  displayName: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedAt: Date;
  downloadUrl: string;
}

// Shared across the replace/upload methods. s3Key points at the exact bucket object
// whose bytes should be pushed back to the source; callers pin the version to upload
// by choosing the key.
interface UploadFromS3Base {
  s3Key: string;
  mimeType: string;
}

// Overwrites the file referenced by replacesFileExternalId. The source client looks
// up the existing file to derive its folder + name so the replacement lands in the
// same place and the source system preserves the file id.
export interface ReplaceFileParams extends UploadFromS3Base {
  replacesFileExternalId: string;
}

// Uploads without any anchor to an existing file. The source system auto-renames
// on a name collision within parentFolderId (or the course root when unset).
export interface UploadNewFileParams extends UploadFromS3Base {
  courseExternalId: string;
  fileName: string;
  parentFolderId?: string;
}

// Uploads into the old file's folder under fileName, then deletes the old file.
// fileName can differ from the old file's name.
export interface SupersedeFileParams extends UploadFromS3Base {
  replacesFileExternalId: string;
  fileName: string;
}
