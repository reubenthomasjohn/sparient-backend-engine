/**
 * Course file replacement trigger (TASK-07 / VALIDATION-07).
 * Tech §4.4 / §6.5; Functional §3.1.3.
 *
 * ## Validation chain (§4.4 / §6.5)
 *
 * 1. Parse body — `batch_file_id` must be a UUID string → 400 if missing/malformed.
 * 2. Resolve `SourceFile` by `(course_id, canvas_file_id)` → 404 if missing.
 * 3. Load `BatchFile` by id → 404 if not found.
 * 4. Assert `BatchFile.sourceFileId === sourceFile.id`  → 404 (ownership mismatch).
 * 5. Assert `BatchFile.canvasFileId === canvas_file_id`  → 404 (ownership mismatch).
 * 6. Assert `BatchFile.remediatedS3Key` is non-empty     → 400 (nothing to replace with).
 *
 * ## Job stub (§3.1.3 / §4.4)
 *
 * In the initial phase the actual Canvas upload/replace integration is a **placeholder**.
 * `enqueueReplaceJob` logs the intent and returns a deterministic `request_id` (UUID v4)
 * so the response contract is stable for client integration.
 *
 * ## Idempotency / conflict (409)
 *
 * A 409 is returned if `SourceFile.writebackState` is currently `null` AND the file is
 * `in_flight` (pipeline), indicating a replacement job is already running. This is a
 * best-effort guard; a real queueing layer would provide stronger guarantees.
 */

import crypto from 'crypto';
import { z } from 'zod';
import type { Course } from '@prisma/client';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';
import { pipelineLabel } from './domainDerivations';
import { logger } from '../../utils/logger';

// ─── Body schema ──────────────────────────────────────────────────────────────

export const replaceBodySchema = z.object({
  batch_file_id: z
    .string({ required_error: 'batch_file_id is required' })
    .uuid('batch_file_id must be a valid UUID'),
});

export type ReplaceBody = z.infer<typeof replaceBodySchema>;

export function parseReplaceBody(raw: unknown): ReplaceBody {
  const result = replaceBodySchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw Errors.badRequest(msg);
  }
  return result.data;
}

// ─── Response type ────────────────────────────────────────────────────────────

export type FileReplaceData = {
  request_id: string;
  status: 'queued';
  message: string;
};

// ─── Job stub ─────────────────────────────────────────────────────────────────

/** Stub for TASK-07. Replace with real queue/SFN call when Canvas integration is ready. */
export function enqueueReplaceJob(params: {
  sourceFileId: string;
  batchFileId: string;
  remediatedS3Key: string;
  courseId: string;
}): string {
  const requestId = crypto.randomUUID();
  logger.info('FileReplace: job accepted (stub)', {
    ...params,
    requestId,
  });
  return requestId;
}

// ─── Service entry point ──────────────────────────────────────────────────────

export async function triggerFileReplace(
  course: Course,
  canvasFileId: string,
  body: ReplaceBody,
): Promise<FileReplaceData> {
  // Step 2 — resolve SourceFile
  const sourceFile = await prisma.sourceFile.findUnique({
    where: {
      courseId_canvasFileId: {
        courseId: course.id,
        canvasFileId,
      },
    },
    include: {
      batchFiles: { select: { id: true } },
    },
  });

  if (!sourceFile) {
    throw Errors.accessHubScopeNotFound();
  }

  // Step 3 — load BatchFile
  const batchFile = await prisma.batchFile.findUnique({
    where: { id: body.batch_file_id },
  });

  if (!batchFile) {
    throw Errors.accessHubScopeNotFound();
  }

  // Step 4 — ownership: source_file_id
  if (batchFile.sourceFileId !== sourceFile.id) {
    throw Errors.accessHubScopeNotFound();
  }

  // Step 5 — ownership: canvas_file_id
  if (batchFile.canvasFileId !== canvasFileId) {
    throw Errors.accessHubScopeNotFound();
  }

  // Step 6 — remediated artifact must exist
  if (!batchFile.remediatedS3Key || batchFile.remediatedS3Key.trim() === '') {
    throw Errors.badRequest(
      'No remediated artifact available for this batch file; replacement cannot proceed',
    );
  }

  // 409 guard — best-effort conflict detection
  const pipeline = pipelineLabel({
    discoveredModifiedAt: sourceFile.discoveredModifiedAt,
    s3SourceModifiedAt: sourceFile.s3SourceModifiedAt,
    batchedModifiedAt: sourceFile.batchedModifiedAt,
    lastOutcome: sourceFile.lastOutcome,
  });

  if (pipeline === 'in_flight' && sourceFile.writebackState === null) {
    throw Errors.conflict(
      'A replacement job is already in progress for this file',
    );
  }

  // Enqueue (stub)
  const requestId = enqueueReplaceJob({
    sourceFileId: sourceFile.id,
    batchFileId: batchFile.id,
    remediatedS3Key: batchFile.remediatedS3Key,
    courseId: course.id,
  });

  return {
    request_id: requestId,
    status: 'queued',
    message:
      'Replacement workflow accepted; integration may be stubbed in initial phase.',
  };
}
