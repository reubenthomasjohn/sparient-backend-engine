import { CanvasCourse, CanvasFile } from '../../../types/canvas';
import { DiscoveredCourse, DiscoveredFile } from '../../../types/source';

export function toDiscoveredCourse(c: CanvasCourse): DiscoveredCourse {
  return {
    externalId: c.id.toString(),
    name: c.name,
    courseCode: c.course_code ?? null,
    termId: c.enrollment_term_id != null ? c.enrollment_term_id.toString() : null,
  };
}

export function toDiscoveredFile(f: CanvasFile): DiscoveredFile {
  // f.size arrives as a string (json-bigint storeAsString). Coerce to number
  // for downstream consumers; a missing/non-numeric size becomes null so
  // SourceFile.sizeBytes (BigInt?) stays clean.
  const sizeNum = f.size != null ? Number(f.size) : NaN;
  return {
    externalId: f.id.toString(),
    displayName: f.display_name,
    fileName: f.filename,
    mimeType: f['content-type'],
    sizeBytes: Number.isFinite(sizeNum) ? sizeNum : null,
    modifiedAt: new Date(f.modified_at),
    downloadUrl: f.url,
  };
}
