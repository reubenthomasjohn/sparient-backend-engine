import prisma from '../src/db/client';
import { ConnectivoResultsPayload, ConnectivoFileResult } from '../src/types/connectivo';

interface FixtureFile {
  canvasFileId: string;
  fileName: string;
}

interface BatchFixture {
  institutionId: string;
  courseId: string;
  batchId: string;
  sourceFiles: { id: string; canvasFileId: string; modifiedAt: Date }[];
}

export interface CourseFixture {
  institutionId: string;
  courseId: string;
  canvasCourseId: string;
}

let counter = 0;
const uniq = () => `${Date.now()}-${counter++}`;

// Bare institution + course, no source files. Caller drives the source_file
// rows themselves (suits FileChangeDetector / BatchBuilder tests).
export async function createCourseFixture(): Promise<CourseFixture> {
  const institution = await prisma.institution.create({
    data: {
      name: 'Test Institution',
      slug: `test-${uniq()}`,
      sourceType: 'canvas',
      credentials: {},
    },
  });
  const canvasCourseId = `course-${uniq()}`;
  const course = await prisma.course.create({
    data: {
      institutionId: institution.id,
      canvasCourseId,
      name: 'Test Course',
    },
  });
  return { institutionId: institution.id, courseId: course.id, canvasCourseId };
}

// Create a complete batch fixture: institution, course, source_files, batch,
// and batch_files. Returns the IDs needed to drive the test.
export async function createBatchFixture(files: FixtureFile[]): Promise<BatchFixture> {
  const institution = await prisma.institution.create({
    data: {
      name: 'Test Institution',
      slug: `test-${uniq()}`,
      sourceType: 'canvas',
      credentials: {},
    },
  });

  const course = await prisma.course.create({
    data: {
      institutionId: institution.id,
      canvasCourseId: `course-${uniq()}`,
      name: 'Test Course',
    },
  });

  const modifiedAt = new Date('2026-05-01T00:00:00Z');

  const sourceFiles = await Promise.all(
    files.map((f) =>
      prisma.sourceFile.create({
        data: {
          courseId: course.id,
          canvasFileId: f.canvasFileId,
          displayName: f.fileName,
          fileName: f.fileName,
          mimeType: 'application/pdf',
          discoveredModifiedAt: modifiedAt,
          s3SourceKey: `incoming/${f.canvasFileId}/v-${modifiedAt.getTime()}/${f.fileName}`,
          s3SourceBucket: 'test-bucket',
          s3SourceModifiedAt: modifiedAt,
          batchedModifiedAt: modifiedAt,
        },
      }),
    ),
  );

  const batch = await prisma.batch.create({
    data: {
      institutionId: institution.id,
      courseId: course.id,
      status: 'pending',
      totalFiles: files.length,
      requestS3Bucket: 'test-bucket',
      requestS3Key: 'requests/test.json',
      batchFiles: {
        create: sourceFiles.map((sf, i) => ({
          sourceFileId: sf.id,
          canvasFileId: files[i].canvasFileId,
          s3SourceKey: sf.s3SourceKey!,
          sourceModifiedAt: modifiedAt,
        })),
      },
    },
  });

  return {
    institutionId: institution.id,
    courseId: course.id,
    batchId: batch.id,
    sourceFiles: sourceFiles.map((sf) => ({
      id: sf.id,
      canvasFileId: sf.canvasFileId,
      modifiedAt,
    })),
  };
}

// Build a minimal-but-valid Connectivo response payload. Per-file results can
// be customized; everything else is filled with sensible defaults.
export function buildPayload(opts: {
  externalBatchId: string;
  connectivoBatchId?: string;
  completedAt?: string;
  files: Array<Partial<ConnectivoFileResult> & {
    file_id: string;
    state: string;
    quality_label?: string | null;
  }>;
}): ConnectivoResultsPayload {
  const fileResults: ConnectivoFileResult[] = opts.files.map((f) => ({
    file_name: f.file_name ?? 'test.pdf',
    file_type: 'pdf',
    source_path: f.source_path ?? 'test/path.pdf',
    remediated_path: f.remediated_path ?? '/test-bucket/remediated/test.pdf',
    custom_fields: {
      file_id: f.file_id,
      canvas_file_id: f.file_id,
    },
    quality_label: f.quality_label ?? 'Excellent',
    state: f.state,
    total_pages: f.total_pages ?? 1,
    processing_time_seconds: f.processing_time_seconds ?? 10,
    compliance_errors: f.compliance_errors ?? 0,
    compliance_warnings: f.compliance_warnings ?? 0,
    total_issues_found: f.total_issues_found ?? 0,
    total_issues_fixed: f.total_issues_fixed ?? 0,
    issues_by_category: f.issues_by_category ?? [],
    error: f.error ?? null,
  }));

  return {
    batch: {
      id: opts.connectivoBatchId ?? `connectivo-${uniq()}`,
      external_batch_id: opts.externalBatchId,
      state: 'Completed',
      started_at: '2026-05-01T00:00:00Z',
      completed_at: opts.completedAt ?? '2026-05-01T01:00:00Z',
      summary: {
        total_files: fileResults.length,
        total_pages: fileResults.reduce((s, f) => s + f.total_pages, 0),
        succeeded: 0,
        failed: 0,
        requires_review: 0,
        skipped: 0,
        total_issues_found: 0,
        total_issues_fixed: 0,
      },
    },
    folders: [
      {
        path: 'test-bucket/incoming/',
        files: fileResults,
      },
    ],
  };
}
