// Shape of the request.json we write to the requests prefix per batch.
// Connectivo polls the bucket and processes any new file at:
//   s3://<institution-bucket>/sparient-remediation-requests/<batchId>.json
export interface ConnectivoBatchPayload {
  batch_id: string;
  // TODO: currently set to batch.createdAt (DB row creation time). Consider using
  // the actual S3 publish timestamp or the latest file modified_at in the batch.
  submitted_at: string;
  force_reprocess: boolean;
  folders: ConnectivoFolderPayload[];
}

export interface ConnectivoFolderPayload {
  // Full S3 path: <bucket>/<source-prefix>/<courseId>/
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
// Zod schemas (runtime validation) + TS types (compile-time).
// Matched to Connectivo v1.0.0 response format.
// ---------------------------------------------------------------------------

import { z } from 'zod';

const issueDetailSchema = z.object({
  name: z.string(),
  status: z.string(),
  detail: z.string(),
});

const issueCategorySchema = z.object({
  found: z.number(),
  fixed: z.number(),
  remaining: z.number(),
  issues: z.array(issueDetailSchema).optional().default([]),
});

const fileResultSchema = z.object({
  file_name: z.string(),
  file_type: z.string().optional(),
  source_path: z.string().optional(),
  remediated_path: z.string().nullable(),
  custom_fields: z.object({
    file_id: z.string(),
    canvas_file_id: z.string(),
  }).passthrough(),
  quality_label: z.string().nullable(),
  state: z.enum(['Completed', 'CompletedWithWarnings', 'Failed']),
  total_pages: z.number(),
  processing_time_seconds: z.number(),
  compliance_errors: z.number().default(0),
  compliance_warnings: z.number().default(0),
  total_issues_found: z.number().default(0),
  total_issues_fixed: z.number().default(0),
  issues_by_category: z.record(z.string(), issueCategorySchema).default({}),
  error: z.string().nullable().optional(),
});

const folderResultSchema = z.object({
  path: z.string(),
  export_path: z.string().optional(),
  summary: z.object({
    total_files: z.number(),
    total_pages: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    requires_review: z.number(),
    skipped: z.number().default(0),
  }).optional(),
  files: z.array(fileResultSchema),
});

export const connectivoResultsSchema = z.object({
  connectivo_version: z.string().optional(),
  generated_at: z.string().optional(),
  batch: z.object({
    id: z.string(),
    external_batch_id: z.string(),
    connection_id: z.string().optional(),
    state: z.string(),
    submitted_at: z.string().optional(),
    started_at: z.string(),
    completed_at: z.string(),
    duration_seconds: z.number().optional(),
    summary: z.object({
      total_folders: z.number().optional(),
      total_files: z.number(),
      total_pages: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      requires_review: z.number(),
      skipped: z.number().default(0),
      quality_breakdown: z.object({
        excellent: z.number(),
        good: z.number(),
        requires_review: z.number(),
        failed: z.number(),
        unchanged: z.number(),
      }).optional(),
      total_processing_time_seconds: z.number().optional(),
      total_issues_found: z.number(),
      total_issues_fixed: z.number(),
    }),
  }),
  folders: z.array(folderResultSchema),
});

export type ConnectivoResultsPayload = z.infer<typeof connectivoResultsSchema>;
export type ConnectivoFolderResult = z.infer<typeof folderResultSchema>;
export type ConnectivoFileResult = z.infer<typeof fileResultSchema>;
export type ConnectivoIssueDetail = z.infer<typeof issueDetailSchema>;
