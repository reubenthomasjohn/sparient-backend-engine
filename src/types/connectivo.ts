// Shape of a batch we expose to Connectivo via GET /connectivo/batches
export interface ConnectivoBatchPayload {
  batch_id: string;
  created_at: string;
  source_system: string;
  institution_id: string;
  course_id: string;
  s3_source_bucket: string;
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

// Shape of the results Connectivo POSTs back to us
export interface ConnectivoResultsPayload {
  batch: {
    id: string;
    external_batch_id: string;
    state: string;
    started_at: string;
    completed_at: string;
    summary: {
      total_files: number;
      total_pages: number;
      succeeded: number;
      failed: number;
      requires_review: number;
      total_issues_found: number;
      total_issues_fixed: number;
    };
  };
  folders: ConnectivoFolderResult[];
}

export interface ConnectivoFolderResult {
  path: string;
  files: ConnectivoFileResult[];
}

export interface ConnectivoFileResult {
  file_id: string;
  file_name: string;
  state: 'Completed' | 'CompletedWithWarnings' | 'Failed';
  quality_label: 'A' | 'AA' | 'AAA' | null;
  remediated_path: string | null;
  total_pages: number;
  processing_time_seconds: number;
  verapdf_errors: number;
  verapdf_warnings: number;
  issues_by_category: Record<string, {
    found: number;
    fixed: number;
    remaining: number;
  }>;
  error: string | null;
}
