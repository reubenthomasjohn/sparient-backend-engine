import type {
  Batch,
  BatchFile,
  Course,
  Institution,
  SourceFile,
} from '@prisma/client';

// Factory helpers — return realistic rows you can override field-by-field.
// Keep additions narrow; tests rely on these defaults, so changes ripple.

export function makeInstitution(overrides: Partial<Institution> = {}): Institution {
  return {
    id: 'inst-1',
    name: 'Test U',
    slug: 'test-u',
    sourceType: 'canvas',
    credentials: { domain: 'canvas.test', account_id: '1', api_token: 't' },
    writebackOptIn: true,
    s3Bucket: null,
    syncEnabled: true,
    syncTime: '02:00',
    lastSyncedAt: null,
    syncConfig: null,
    s3LayoutConfig: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: 'course-1',
    institutionId: 'inst-1',
    canvasCourseId: '101',
    canvasTermId: 'term-1',
    name: 'Course One',
    courseCode: 'C-1',
    writebackOptIn: null,
    lastSyncedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeSourceFile(overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    id: 'sf-1',
    courseId: 'course-1',
    canvasFileId: 'cf-1',
    displayName: 'doc.pdf',
    fileName: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1000n,
    discoveredModifiedAt: new Date('2026-04-01T00:00:00Z'),
    s3SourceKey: 'course-1/cf-1/v-1700000000000/doc.pdf',
    s3SourceBucket: 'sparient-inst-1',
    s3SourceModifiedAt: new Date('2026-04-01T00:00:00Z'),
    batchedModifiedAt: new Date('2026-04-01T00:00:00Z'),
    lastOutcome: null,
    lastFailureReason: null,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    writebackState: null,
    lastWritebackModifiedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-1',
    institutionId: 'inst-1',
    courseId: 'course-1',
    connectivoBatchId: null,
    status: 'pending',
    isInitialSync: false,
    isRetry: false,
    requestS3Bucket: 'sparient-inst-1',
    requestS3Key: 'sparient-remediation-requests/batch-1.json',
    requestWrittenAt: new Date('2026-04-01T00:05:00Z'),
    completedAt: null,
    totalFiles: 1,
    totalPages: null,
    succeeded: null,
    failed: null,
    requiresReview: null,
    totalIssuesFound: null,
    totalIssuesFixed: null,
    numRetries: 0,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeBatchFile(overrides: Partial<BatchFile> = {}): BatchFile {
  return {
    id: 'bf-1',
    batchId: 'batch-1',
    sourceFileId: 'sf-1',
    canvasFileId: 'cf-1',
    s3SourceKey: 'course-1/cf-1/v-1700000000000/doc.pdf',
    sourceModifiedAt: new Date('2026-04-01T00:00:00Z'),
    connectivoState: 'completed',
    qualityLabel: 'Good',
    remediatedS3Key: 'connectivo-remediated/course-1/cf-1.pdf',
    remediatedS3Bucket: 'sparient-inst-1',
    totalPages: 10,
    processingTimeSecs: 5,
    complianceErrors: 0,
    complianceWarnings: 0,
    totalIssuesFound: 0,
    totalIssuesFixed: 0,
    errorMessage: null,
    reviewAcknowledged: false,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}
