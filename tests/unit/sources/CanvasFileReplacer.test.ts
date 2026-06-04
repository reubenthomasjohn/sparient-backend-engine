import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { CanvasFileReplacer } from '../../../src/services/sources/canvas/CanvasFileReplacer';
import type { CanvasClient } from '../../../src/services/sources/canvas/CanvasClient';
import type { CanvasFile, CanvasFolder } from '../../../src/types/canvas';
import { s3Service } from '../../../src/services/storage/S3Service';

vi.mock('../../../src/services/storage/S3Service', () => ({
  s3Service: { getObjectBytes: vi.fn() },
}));

function canvasFile(overrides: Partial<CanvasFile> = {}): CanvasFile {
  return {
    id: 123,
    uuid: 'u',
    folder_id: 9,
    display_name: 'doc.pdf',
    filename: 'doc.pdf',
    'content-type': 'application/pdf',
    url: 'http://x',
    size: 1000,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    modified_at: '2026-04-01T00:00:00Z',
    locked: false,
    hidden: false,
    ...overrides,
  };
}

function canvasFolder(overrides: Partial<CanvasFolder> = {}): CanvasFolder {
  return {
    id: 9,
    name: 'Course Files',
    full_name: 'course files',
    parent_folder_id: null,
    context_type: 'Course',
    context_id: 101,
    ...overrides,
  };
}

let client: DeepMockProxy<CanvasClient>;
let replacer: CanvasFileReplacer;

beforeEach(() => {
  client = mockDeep<CanvasClient>();
  replacer = new CanvasFileReplacer(client);
  vi.mocked(s3Service.getObjectBytes).mockReset();
  vi.mocked(s3Service.getObjectBytes).mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe('isCanvasFileEligibleToReplace', () => {
  it('returns ineligible/deleted on a 404', async () => {
    const err: any = new Error('404');
    err.isAxiosError = true;
    err.response = { status: 404 };
    client.getFile.mockRejectedValue(err);

    const r = await replacer.isCanvasFileEligibleToReplace('cf-1', new Date());
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('deleted');
  });

  it('rethrows non-404 errors', async () => {
    client.getFile.mockRejectedValue(new Error('boom'));
    await expect(
      replacer.isCanvasFileEligibleToReplace('cf-1', new Date()),
    ).rejects.toThrow('boom');
  });

  it('returns ineligible/modified when Canvas modified_at is newer', async () => {
    client.getFile.mockResolvedValue(
      canvasFile({ modified_at: '2026-04-02T00:00:00Z' }),
    );
    const r = await replacer.isCanvasFileEligibleToReplace(
      'cf-1',
      new Date('2026-04-01T00:00:00Z'),
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('modified');
    expect(r.currentModifiedAt).toEqual(new Date('2026-04-02T00:00:00Z'));
  });

  it('treats equal timestamps as eligible (strict >)', async () => {
    client.getFile.mockResolvedValue(canvasFile());
    const r = await replacer.isCanvasFileEligibleToReplace(
      'cf-1',
      new Date('2026-04-01T00:00:00Z'),
    );
    expect(r.eligible).toBe(true);
  });
});

describe('replaceFile', () => {
  it('calls Canvas getFile only ONCE (single-fetch refactor)', async () => {
    client.getFile.mockResolvedValue(canvasFile());
    client.getFolder.mockResolvedValue(canvasFolder());
    client.uploadCourseFile.mockResolvedValue(canvasFile({ modified_at: '2026-04-02T00:00:00Z' }));

    await replacer.replaceFile({
      fileExternalId: 'cf-1',
      knownModifiedAt: new Date('2026-04-01T00:00:00Z'),
      s3Bucket: 'bucket',
      s3Key: 'connectivo-remediated/foo.pdf',
      mimeType: 'application/pdf',
    });

    expect(client.getFile).toHaveBeenCalledTimes(1);
  });

  it('uploads with onDuplicate=overwrite using the existing folder/filename', async () => {
    client.getFile.mockResolvedValue(canvasFile({ folder_id: 9, filename: 'real.pdf' }));
    client.getFolder.mockResolvedValue(canvasFolder({ context_id: 101 }));
    client.uploadCourseFile.mockResolvedValue(canvasFile());

    const result = await replacer.replaceFile({
      fileExternalId: 'cf-1',
      knownModifiedAt: new Date('2026-04-01T00:00:00Z'),
      s3Bucket: 'bucket',
      s3Key: 'connectivo-remediated/foo.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.status).toBe('replaced');
    expect(client.uploadCourseFile).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        courseId: '101',
        fileName: 'real.pdf',
        parentFolderId: '9',
        onDuplicate: 'overwrite',
      }),
    );
  });

  it('returns skipped on Canvas-side modification — no upload, no S3 read', async () => {
    client.getFile.mockResolvedValue(canvasFile({ modified_at: '2026-04-05T00:00:00Z' }));

    const result = await replacer.replaceFile({
      fileExternalId: 'cf-1',
      knownModifiedAt: new Date('2026-04-01T00:00:00Z'),
      s3Bucket: 'bucket',
      s3Key: 'connectivo-remediated/foo.pdf',
      mimeType: 'application/pdf',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'modified' });
    expect(s3Service.getObjectBytes).not.toHaveBeenCalled();
    expect(client.uploadCourseFile).not.toHaveBeenCalled();
  });
});

describe('supersedeFile', () => {
  it('only deletes the old file after a successful upload', async () => {
    const callOrder: string[] = [];
    client.getFile.mockResolvedValue(canvasFile());
    client.getFolder.mockResolvedValue(canvasFolder());
    client.uploadCourseFile.mockImplementation(async () => {
      callOrder.push('upload');
      return canvasFile();
    });
    client.deleteFile.mockImplementation(async () => {
      callOrder.push('delete');
    });

    await replacer.supersedeFile({
      fileExternalId: 'cf-1',
      knownModifiedAt: new Date('2026-04-01T00:00:00Z'),
      s3Bucket: 'bucket',
      s3Key: 'connectivo-remediated/foo.pdf',
      fileName: 'new.pdf',
      mimeType: 'application/pdf',
    });

    expect(callOrder).toEqual(['upload', 'delete']);
  });

  it('does not delete when upload fails', async () => {
    client.getFile.mockResolvedValue(canvasFile());
    client.getFolder.mockResolvedValue(canvasFolder());
    client.uploadCourseFile.mockRejectedValue(new Error('upload failed'));

    await expect(
      replacer.supersedeFile({
        fileExternalId: 'cf-1',
        knownModifiedAt: new Date('2026-04-01T00:00:00Z'),
        s3Bucket: 'bucket',
        s3Key: 'k',
        fileName: 'new.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow();

    expect(client.deleteFile).not.toHaveBeenCalled();
  });
});
