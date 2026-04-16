# File Lifecycle Reference

Files no longer have a `status` enum. Their position in the pipeline is inferred from a set of monotonic timestamps plus a terminal `last_outcome`. This makes the model idempotent under retries, crashes, and out-of-order events.

---

## Source file timestamps

Every `source_file` carries these fields:

| Field | Meaning |
|---|---|
| `discovered_modified_at` | The `modified_at` we last saw on Canvas. Advanced by `FileChangeDetector` when the content changes. |
| `s3_source_key` / `s3_source_bucket` | Pointer to the version currently in S3. Key is content-addressed: `…/files/:canvasFileId/v-:modifiedAtMs/:fileName`. |
| `s3_source_modified_at` | The `modified_at` that was uploaded to S3. Always `<= discovered_modified_at`. |
| `batched_modified_at` | The `modified_at` that was last sent in a batch to Connectivo. Always `<= s3_source_modified_at`. |
| `last_outcome` | Terminal Connectivo outcome: `completed`, `completed_with_warnings`, `failed`, `permanently_failed`, or `deleted`. `null` until first terminal event. |
| `last_failure_reason`, `retry_count`, `max_retries` | Retry bookkeeping. `retry_count >= max_retries` is what gates retries. |
| `next_retry_at` | Observability only — no longer drives scheduling. Retries fire during the next course discover pass (triggered by the 15-min tick). |
| `writeback_state`, `last_writeback_modified_at` | Writeback bookkeeping. `last_writeback_modified_at` is consulted by `FileChangeDetector` to ignore our own writebacks. |

---

## Derived states (queries, not columns)

| State | Predicate |
|---|---|
| Needs upload | `s3_source_modified_at IS NULL OR s3_source_modified_at < discovered_modified_at` |
| Needs batching | `s3_source_modified_at IS NOT NULL AND (batched_modified_at IS NULL OR batched_modified_at < s3_source_modified_at)` |
| In-flight with Connectivo | `batched_modified_at = s3_source_modified_at AND last_outcome IS NULL` (or outcome is older than the current batched version) |
| Terminal | `last_outcome IS NOT NULL AND batched_modified_at = s3_source_modified_at` |
| Deleted from source | `last_outcome = 'deleted'` |
| Retry-eligible | `last_outcome = 'failed' AND retry_count < max_retries` (retried during next course discover pass) |

---

## Transitions

```
                ┌──────────────────────┐
                │  FileChangeDetector  │  bumps discovered_modified_at on content change
                └──────────┬───────────┘
                           │
                           ▼
                 ┌──────────────────┐
                 │  SFN: upload-    │  streams Canvas → S3,
                 │  file (Map,     │  then conditionally UPDATEs
                 │  parallel)      │  s3_source_modified_at only if the
                 └──────────┬───────┘   upload's modifiedAtMs is newer
                            │           Step Functions waits for ALL uploads
                            ▼
                 ┌──────────────────┐
                 │ SFN: batch-     │  atomic claim:
                 │ publish         │  UPDATE WHERE batched_modified_at IS NULL
                 └──────────┬───────┘   OR batched_modified_at < s3_source_modified_at
                            │           writes request.json to S3
                            ▼
                  Connectivo polls requests bucket,
                  writes response.json to responses bucket
                            │
                            ▼ (S3 event → SQS)
                 ┌──────────────────────┐
                 │ RemediationService   │  writes last_outcome;
                 └──────────────────────┘  missing files → failed
```

Every write along this chain is monotonic — a stale worker holding an old `modifiedAtMs` cannot clobber a newer upload because the conditional WHERE filters it out.

---

## Batch statuses

The `batch.status` enum still exists and tracks the batch-as-a-whole:

| Status | Meaning | Set by |
|---|---|---|
| `pending` | Created, waiting for Connectivo acknowledgement | `BatchBuilder` |
| `processing` | Connectivo has acknowledged | `POST /connectivo/batches/:id/acknowledge` |
| `completed` | Terminal, all files succeeded | `RemediationService` |
| `completed_with_warnings` | Terminal, at least one warning/failure | `RemediationService` |
| `failed` | Terminal, all files failed | `RemediationService` |

Acknowledgement is idempotent: replaying the same `connectivo_batch_id` returns 200; a different id on a processing batch returns 409.

Result submission is idempotent: replaying with the same `connectivo_batch_id` on a terminal batch is a no-op.

---

## What replaced what

| Old (status enum) | New |
|---|---|
| `pending`, `uploading_to_s3` | No `s3_source_modified_at`, or `s3_source_modified_at < discovered_modified_at` |
| `uploaded_to_s3` | `s3_source_modified_at` set, `batched_modified_at < s3_source_modified_at` |
| `batched` / `processing` | `batched_modified_at = s3_source_modified_at`, `last_outcome` still null (or stale) |
| `completed` / `completed_with_warnings` | `last_outcome` set to the same |
| `failed` / `permanently_failed` | `last_outcome = 'failed'` or `'permanently_failed'` (terminal) |
| `deleted_from_source` | `last_outcome = 'deleted'` |
| `pending_resubmit` flag | Removed — `discovered_modified_at > s3_source_modified_at` expresses the same thing |
