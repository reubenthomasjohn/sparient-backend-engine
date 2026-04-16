# File Lifecycle Reference

A file's position in the pipeline is inferred from monotonic timestamps plus a terminal `last_outcome`. No status enum.

---

## Source file fields

| Field | Meaning |
|---|---|
| `discovered_modified_at` | The `modified_at` we last saw on Canvas. Advanced by `FileChangeDetector` when content changes. |
| `s3_source_key` / `s3_source_bucket` | Pointer to the version in S3. Content-addressed: `<instId>/<courseId>/<fileId>/v-<ms>/<fileName>`. |
| `s3_source_modified_at` | The `modified_at` that was uploaded to S3. Always `<= discovered_modified_at`. |
| `batched_modified_at` | The `modified_at` that was last sent to Connectivo in a batch. Always `<= s3_source_modified_at`. |
| `last_outcome` | Terminal outcome: `completed`, `completed_with_warnings`, `failed`, `permanently_failed`, or `deleted`. `null` until first terminal event. |
| `last_failure_reason`, `retry_count`, `max_retries` | Retry bookkeeping. `retry_count >= max_retries` gates retries. |
| `next_retry_at` | Observability only — retries fire during the next course discover pass. |
| `writeback_state`, `last_writeback_modified_at` | Writeback bookkeeping. `last_writeback_modified_at` prevents `FileChangeDetector` from re-processing our own writebacks. |

---

## Derived states

| State | Predicate |
|---|---|
| Needs upload | `s3_source_modified_at IS NULL OR s3_source_modified_at < discovered_modified_at` |
| Needs batching | `s3_source_modified_at IS NOT NULL AND (batched_modified_at IS NULL OR batched_modified_at < s3_source_modified_at)` |
| In-flight with Connectivo | `batched_modified_at = s3_source_modified_at AND last_outcome IS NULL` |
| Terminal | `last_outcome IS NOT NULL AND batched_modified_at = s3_source_modified_at` |
| Deleted from source | `last_outcome = 'deleted'` |
| Retry-eligible | `last_outcome = 'failed' AND retry_count < max_retries` |

---

## Transitions

```
FileChangeDetector          bumps discovered_modified_at on content change
        │
        ▼
SFN: upload-file            streams Canvas → S3, conditionally UPDATEs
(Map, parallel, max 10)     s3_source_modified_at (monotonic guard)
        │                   Step Functions waits for ALL uploads
        ▼
SFN: batch-publish          atomic claim: UPDATE WHERE batched_modified_at IS NULL
                            OR batched_modified_at < s3_source_modified_at
                            writes one request.json per course to S3
        │
        ▼
Connectivo                  polls requests bucket, remediates,
                            writes response.json to responses bucket
        │
        ▼ (S3 event → SQS)
RemediationService          writes last_outcome; missing files → failed
```

Every write is monotonic — a stale invocation holding an old `modifiedAtMs` cannot clobber a newer upload because the conditional WHERE filters it out.

---

## Batch statuses

| Status | Meaning | Set by |
|---|---|---|
| `pending` | Created, request.json written to S3, waiting for Connectivo response | `BatchBuilder` + `RequestPublisher` |
| `completed` | Terminal, all files succeeded | `RemediationService` |
| `completed_with_warnings` | Terminal, at least one warning/failure | `RemediationService` |
| `failed` | Terminal, all files failed (or request publish failed) | `RemediationService` or `BatchBuilder` rollback |

Response processing is idempotent — if Connectivo re-writes the response.json, the duplicate is a no-op (batch is already terminal).
