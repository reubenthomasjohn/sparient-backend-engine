import prisma from '../../src/db/client';

// Seed helpers used by integration tests. They write directly via the real
// Prisma client; tests can override fields per-row.

export async function seedInstitution(overrides: Record<string, unknown> = {}) {
  return prisma.institution.create({
    data: {
      name: 'Integration U',
      slug: `int-u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceType: 'canvas',
      credentials: { domain: 'canvas.test', account_id: '1', api_token: 't' },
      writebackOptIn: true,
      ...overrides,
    },
  });
}

export async function seedCourse(institutionId: string, overrides: Record<string, unknown> = {}) {
  return prisma.course.create({
    data: {
      institutionId,
      canvasCourseId: '101',
      name: 'Course One',
      ...overrides,
    },
  });
}

export async function seedSourceFile(courseId: string, overrides: Record<string, unknown> = {}) {
  return prisma.sourceFile.create({
    data: {
      courseId,
      canvasFileId: 'cf-1',
      displayName: 'doc.pdf',
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1000n,
      discoveredModifiedAt: new Date('2026-04-01T00:00:00Z'),
      s3SourceKey: '101/cf-1/v-1700000000000/doc.pdf',
      s3SourceBucket: 'sparient-int',
      s3SourceModifiedAt: new Date('2026-04-01T00:00:00Z'),
      ...overrides,
    },
  });
}
