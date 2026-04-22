// Shape of the request.json we write to the requests prefix per batch.
// Connectivo polls the bucket and processes any new file at:
//   s3://<S3_BUCKET>/sparient-remediation-requests/<institutionId>/<courseId>/<batchId>.json
export interface ConnectivoBatchPayload {
  batch_id: string;
  // TODO: currently set to batch.createdAt (DB row creation time). Consider using
  // the actual S3 publish timestamp or the latest file modified_at in the batch.
  submitted_at: string;
  force_reprocess: boolean;
  folders: ConnectivoFolderPayload[];
}

export interface ConnectivoFolderPayload {
  // Full S3 path: <bucket>/<source-prefix>/<institutionId>/<courseId>/
  path: string;
  files: ConnectivoFilePayload[];
}

export interface ConnectivoFilePayload {
  // Path fragment relative to folder.path: <canvasFileId>/v-<modifiedAtMs>/<fileName>
  name: string;
  file_id: string;       // our source_file.id (UUID)
  canvas_file_id: string;
}

// ---------------------------------------------------------------------------
// Response.json — shape of what Connectivo writes to the responses bucket.
// Both Zod schemas (runtime validation) and TS interfaces (compile-time) live
// here so the contract is in one file.
// ---------------------------------------------------------------------------

import { z } from 'zod';

const issueCategorySchema = z.object({
  found: z.number(),
  fixed: z.number(),
  remaining: z.number(),
});

const fileResultSchema = z.object({
  file_id: z.string().min(1),
  file_name: z.string(),
  state: z.enum(['Completed', 'CompletedWithWarnings', 'Failed']),
  quality_label: z.enum(['A', 'AA', 'AAA']).nullable(),
  remediated_path: z.string().nullable(),
  total_pages: z.number(),
  processing_time_seconds: z.number(),
  verapdf_errors: z.number(),
  verapdf_warnings: z.number(),
  issues_by_category: z.record(z.string(), issueCategorySchema),
  error: z.string().nullable(),
});

const folderResultSchema = z.object({
  path: z.string(),
  files: z.array(fileResultSchema),
});

export const connectivoResultsSchema = z.object({
  batch: z.object({
    id: z.string(),
    external_batch_id: z.string(),
    state: z.string(),
    started_at: z.string(),
    completed_at: z.string(),
    summary: z.object({
      total_files: z.number(),
      total_pages: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      requires_review: z.number(),
      total_issues_found: z.number(),
      total_issues_fixed: z.number(),
    }),
  }),
  folders: z.array(folderResultSchema),
});

export type ConnectivoResultsPayload = z.infer<typeof connectivoResultsSchema>;
export type ConnectivoFolderResult = z.infer<typeof folderResultSchema>;
export type ConnectivoFileResult = z.infer<typeof fileResultSchema>;
