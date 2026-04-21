// Shape of the request.json we write to the requests prefix per batch.
// Connectivo polls the bucket and processes any new file at:
//   s3://<S3_BUCKET>/sparient-remediation-requests/<institutionId>/<courseId>/<batchId>.json
export interface ConnectivoBatchPayload {
  batch_id: string;
  created_at: string;
  source_system: string;
  institution_id: string;
  course_id: string;
  s3_source_bucket: string;
  s3_source_prefix: string;
  s3_remediated_bucket: string;
  s3_remediated_prefix: string;
  // Full S3 key (including prefix) where Connectivo writes the response.json.
  response_s3_bucket: string;
  response_s3_key: string;
  files: ConnectivoFilePayload[];
}

export interface ConnectivoFilePayload {
  file_id: string;       // our source_file.id (UUID) — stable internal reference
  canvas_file_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number | null;
  s3_key: string;
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
