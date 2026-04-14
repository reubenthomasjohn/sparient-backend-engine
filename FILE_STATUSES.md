# File Status Reference

This document describes every status a `source_file` can be in, what it means, what drives the transition into it, and where the code lives.

---

## Status flow

```
                        ┌─────────────────────────────────────────────────────────┐
                        │                    Normal path                          │
                        ▼                                                         │
pending ──► uploading_to_s3 ──► uploaded_to_s3 ──► batched ──► completed         │
                │                                     │       └─► completed_with_warnings
                │                                     │
                │                              ┌──► failed ──► permanently_failed
                │                              │
                └──────────────────────────────┘
                       (upload failed)


   Canvas removes the file at any point ──► deleted_from_source
```

---

## Statuses

### `pending`
**Meaning:** The file has been discovered (new or changed) and is waiting to be downloaded from Canvas and uploaded to S3.

**Set by:**
- `FileChangeDetector` — when a brand new file is found
- `FileChangeDetector` — when an existing file's `modified_at` has advanced (content changed), for all non-in-flight, non-terminal statuses
- `FileChangeDetector` — initial value on `sourceFile.create`

**Code:** `FileChangeDetector.ts`

---

### `uploading_to_s3`
**Meaning:** The file is currently being downloaded from Canvas and streamed to S3. This is a transient in-progress marker. If the process crashes here, the file will be stuck in this status and requires operator intervention or a retry mechanism.

**Set by:**
- `SyncOrchestrator.uploadFileToS3` — at the start of the upload

**Code:** `SyncOrchestrator.ts → uploadFileToS3()`

---

### `uploaded_to_s3`
**Meaning:** The file has been successfully uploaded to S3 and is waiting to be included in the next batch for Connectivo. `s3_source_key` and `s3_source_bucket` are populated at this point.

**Set by:**
- `SyncOrchestrator.uploadFileToS3` — on successful S3 upload
- `RemediationService.handlePendingResubmits` — resets files that were modified while their batch was being processed, so `BatchBuilder` picks them up again
- `RetryService` — resets eligible failed files so `BatchBuilder` picks them up in a retry batch

**Code:** `SyncOrchestrator.ts → uploadFileToS3()`, `RemediationService.ts → handlePendingResubmits()`, `RetryService.ts`

---

### `batched`
**Meaning:** The file has been included in a batch and a `batch_file` row exists linking it to that batch. The batch is available for Connectivo to pick up via `GET /connectivo/batches`. Connectivo may or may not have acknowledged it yet.

**Set by:**
- `BatchBuilder.createBatch` — atomically with the creation of the `batch` and `batch_file` rows (single transaction)

**Code:** `BatchBuilder.ts → createBatch()`

---

### `completed`
**Meaning:** Connectivo processed the file successfully with no warnings. A remediated file exists in the S3 remediated bucket. `batch_file.connectivo_state = completed`, `quality_label` is set.

**Set by:**
- `RemediationService.handleResults` — when Connectivo POSTs results and the file's state is `Completed`

**Code:** `RemediationService.ts → handleResults()`

---

### `completed_with_warnings`
**Meaning:** Connectivo processed the file but there are remaining accessibility issues it could not fix automatically. The remediated file is in S3 and may still be usable. `batch_file.connectivo_state = completed_with_warnings`.

**Set by:**
- `RemediationService.handleResults` — when Connectivo POSTs results and the file's state is `CompletedWithWarnings`

**Code:** `RemediationService.ts → handleResults()`

---

### `failed`
**Meaning:** Something went wrong — either the S3 upload failed or Connectivo returned a failure for this file. `last_failure_reason` is populated. The file is eligible for retry once `next_retry_at` is reached. `retry_count` is incremented on each failure.

**Retry schedule:** `next_retry_at = now + (base_delay_minutes × 4^retry_count)`
(exponential backoff — e.g. 30 min, 2 hr, 8 hr with default base of 30 min)

**Set by:**
- `SyncOrchestrator.uploadFileToS3` — on S3 upload error
- `RemediationService.handleResults` — when Connectivo POSTs results and the file's state is `Failed`, and `retry_count < max_retries`

**Code:** `SyncOrchestrator.ts → uploadFileToS3()`, `RemediationService.ts → handleResults()`

---

### `permanently_failed`
**Meaning:** The file has exhausted all retry attempts (`retry_count >= max_retries`, default 3). It will not be retried automatically. Operator intervention is required — either fix the underlying issue and manually reset the status, or accept the file cannot be remediated.

**Set by:**
- `RemediationService.handleResults` — when Connectivo returns a failure and `retry_count >= max_retries`

**Code:** `RemediationService.ts → handleResults()`

---

### `deleted_from_source`
**Meaning:** Canvas no longer returns this file for the course. It has been removed from the source system. No further processing will occur. Historical `batch_file` records are preserved.

**Set by:**
- `SyncOrchestrator.syncCourse` — when `FileChangeDetector` identifies a file in the DB whose `canvas_file_id` is absent from the latest Canvas response

**Code:** `SyncOrchestrator.ts → syncCourse()`, detection in `FileChangeDetector.ts → detect()`

---

## Batch status reference

Batch statuses are separate from file statuses and track the lifecycle of the batch as a whole.

| Status | Meaning | Set by |
|--------|---------|--------|
| `pending` | Batch created, waiting for Connectivo to acknowledge | `BatchBuilder.createBatch` |
| `processing` | Connectivo has acknowledged and is working on it | `POST /connectivo/batches/:id/acknowledge` |
| `completed` | All files succeeded | `RemediationService.handleResults` |
| `completed_with_warnings` | At least one file failed or requires review | `RemediationService.handleResults` |
| `failed` | All files failed | `RemediationService.handleResults` |
| `cancelled` | Reserved — not yet used | — |

---

## Special flags on `source_file`

| Field | Meaning |
|-------|---------|
| `pending_resubmit` | Set to `true` when a file's content changes in Canvas while it is currently `batched`. After the in-flight batch completes, `RemediationService` resets the file to `uploaded_to_s3` so it gets picked up in the next batch. |
| `last_writeback_modified_at` | The `modified_at` timestamp of a file that we ourselves wrote back to Canvas. Used by `FileChangeDetector` to skip our own writeback and prevent an infinite loop. |
