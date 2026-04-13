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
