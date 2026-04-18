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

// Shared by replaceFile + supersedeFile. knownModifiedAt is the source-side modified_at
// we observed when we pulled the bytes; the replacer refuses to proceed if the source
// file has changed since then (optimistic concurrency — protects against clobbering
// an edit a teacher made between our sync and the write-back). Mandatory: callers
// with no anchor timestamp must go through uploadNewFile instead.
interface AnchoredToExistingFile {
  fileExternalId: string;
  knownModifiedAt: Date;
}

// Overwrites the file referenced by fileExternalId. The source client looks up the
// existing file to derive its folder + name so the replacement lands in the same
// place and the source system preserves the file id.
export interface ReplaceFileParams extends UploadFromS3Base, AnchoredToExistingFile {}

// Uploads without any anchor to an existing file. The source system auto-renames
// on a name collision within parentFolderId (or the course root when unset).
export interface UploadNewFileParams extends UploadFromS3Base {
  courseExternalId: string;
  fileName: string;
  parentFolderId?: string;
}

// Uploads into the old file's folder under fileName, then deletes the old file.
// fileName can differ from the old file's name.
export interface SupersedeFileParams extends UploadFromS3Base, AnchoredToExistingFile {
  fileName: string;
}

// Result of isFileEligibleToReplace. 'modified' = source-side has a newer modified_at
// than knownModifiedAt; 'deleted' = the source no longer exposes the file.
// currentModifiedAt is populated when reason === 'modified' so callers can log the
// drift (vs the knownModifiedAt they passed in) without re-fetching.
export type ReplaceIneligibleReason = 'modified' | 'deleted';

export interface ReplaceEligibility {
  eligible: boolean;
  reason: ReplaceIneligibleReason | null;
  currentModifiedAt?: Date;
}

// replaceFile / supersedeFile return this so bulk callers can skip-and-continue on
// a per-file basis. 'skipped' means nothing was uploaded — the source-side file
// had moved on and overwriting would clobber someone else's edit.
export type ReplaceResult =
  | { status: 'replaced'; file: DiscoveredFile }
  | { status: 'skipped'; reason: ReplaceIneligibleReason };
