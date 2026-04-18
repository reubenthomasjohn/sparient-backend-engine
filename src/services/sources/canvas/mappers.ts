import { CanvasFile } from '../../../types/canvas';
import { DiscoveredFile } from '../../../types/source';

export function toDiscoveredFile(f: CanvasFile): DiscoveredFile {
  return {
    externalId: f.id.toString(),
    displayName: f.display_name,
    fileName: f.filename,
    mimeType: f['content-type'],
    sizeBytes: f.size ?? null,
    modifiedAt: new Date(f.modified_at),
    downloadUrl: f.url,
  };
}
