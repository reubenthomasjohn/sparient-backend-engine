# Sync Edge Cases

This document covers every meaningful edge case in the file sync and remediation pipeline — what happens today, whether it is handled correctly, and what needs fixing.

Status key: ✅ Handled correctly · ⚠️ Partial / assumption made · ❌ Design flaw

---

## 1. File Discovery

### 1.1 New file added to Canvas
**✅ Handled**
`FileChangeDetector` finds no existing DB record → creates one with status `pending` → uploaded to S3 → batched.

---

### 1.2 File content modified between syncs
**✅ Handled**
Canvas `modified_at` advances. `FileChangeDetector` compares it against `canvas_modified_at` in our DB → detects the change → resets status to `pending` → re-uploads new version to S3 (S3 versioning preserves the old copy) → re-batched.

---

### 1.3 File metadata changed (rename, move) but content unchanged
**✅ Handled (by design)**
Canvas `modified_at` only changes when file *content* changes. A rename or folder move updates `updated_at` but not `modified_at`. Our change detection is based on `modified_at`, so metadata-only changes are correctly ignored.

---

### 1.4 File deleted from Canvas
**✅ Handled**
After fetching all files for a course, `FileChangeDetector` cross-references with the DB. Files present in DB but absent from Canvas are marked `deleted_from_source`. They are never re-batched.

---

### 1.5 File deleted then re-uploaded to Canvas
**✅ Handled**
Canvas assigns a new file ID on re-upload. Our system sees it as a brand-new file (no existing record for that ID) and processes it from scratch.

---

### 1.6 File has wrong MIME type (`application/octet-stream`)
**✅ Handled**
Server-side Canvas `content_types[]` filter catches correctly typed files. A secondary client-side extension check (`.pdf`, `.docx`, `.pptx`, `.xlsx`, etc.) catches anything Canvas mislabelled.

---

### 1.7 File is locked or hidden in Canvas
**⚠️ Assumption**
Canvas still returns locked/hidden files in the files API (they are accessible to admins/teachers). We process them as normal. If the institution requires locked files to be skipped, a filter on `file.locked === true` can be added to `CanvasFileFetcher`.

---

## 2. Incremental Sync / Timing

### 2.1 File uploaded between two sync runs
**✅ Handled**
Standard incremental case. `updated_at >= lastSyncedAt` passes the filter. Picked up on the next run.

---

### 2.2 File uploaded *during* a sync run (after we fetched files for that course)
**✅ Handled**
`lastSyncedAt` is recorded at **sync start time**, not end time. The file's `updated_at` will be `>= lastSyncedAt` on the *next* run, so it is caught then with at most a one-run delay.

---

### 2.3 Sync runs but Canvas API returns no files (network error, bug)
**⚠️ Partial**
If an exception is thrown, `lastSyncedAt` is not updated (the course-level update is at the end of `syncCourse`). A repeat sync will re-attempt. However if the API silently returns an empty list (no error), `lastSyncedAt` is still updated and those files may be missed. Use `?force=true` to recover manually.

---

### 2.4 `lastSyncedAt` is stale due to a past bug or failed sync
**✅ Handled (manually)**
`POST /api/v1/sync/institutions/:id/courses/:courseId?force=true` clears `lastSyncedAt`, forcing a full re-scan.

---

## 3. Modification During Remediation (Race Conditions)

### 3.1 File modified *before* it is sent to Connectivo (status: `pending` / `ready`)
**✅ Handled**
`FileChangeDetector` detects the change → resets status to `pending` → re-uploads new version to S3 → re-batched. The old S3 version is preserved by versioning.

---

### 3.2 File modified *while Connectivo is processing it* (status: `processing`)
**✅ Handled**
`FileChangeDetector` sets `pending_resubmit = true` and updates `canvas_modified_at`. The new version is uploaded to S3 (versioning keeps both). When Connectivo's webhook arrives, `RemediationService` stores the result for the old version, then immediately creates a new batch for the new version.

---

### 3.3 File modified *multiple times* while Connectivo is processing
**✅ Handled**
Each sync run overwrites `canvas_modified_at` with the latest value. `pending_resubmit` is already `true`. When the webhook arrives, the latest version in S3 is what gets re-batched.

---

### 3.4 File written back to Canvas by us, triggering a spurious change detection
**✅ Handled**
On writeback we record `last_writeback_modified_at`. `FileChangeDetector` skips files where `discovered.modifiedAt === last_writeback_modified_at`.

---

## 4. Status Transitions

### 4.1 File fails remediation (status: `failed`) then content changes
**✅ Handled**
`FileChangeDetector` detects the change → resets to `pending`, clears `retry_count` and `next_retry_at` → treated as fresh. The content changed so a new remediation attempt is appropriate.

---

### 4.2 File hits max retries (status: `permanently_failed`) then content changes
**❌ Design flaw**
Currently `FileChangeDetector` skips `permanently_failed` files entirely. But if the instructor uploads a genuinely new version, it deserves a fresh attempt — the old failure was for old content.

**Fix:** Treat a content change on a `permanently_failed` file the same as `failed`: reset to `pending`, clear retry counters.

---

### 4.3 File stuck in `uploading_to_s3` after a server crash
**❌ Design flaw**
`uploading_to_s3` is a transient status — set at upload start, cleared at end. If the server crashes mid-upload, the file is stuck in this status forever. `FileChangeDetector` only re-queues if content changes; if the content has not changed it will be skipped forever.

**Fix:** Add a `stuck_threshold` (e.g. 30 minutes). The retry job should reset files where `status = 'uploading_to_s3' AND updated_at < NOW() - interval '30 minutes'` back to `pending`.

---

### 4.4 Concurrent syncs picking up the same files
**❌ Design flaw**
Two simultaneous sync triggers (e.g. cron + manual API call) could both query `status = 'ready'` before either completes the `BatchBuilder` transaction. The same file could land in two batches.

**Fix:** In `BatchBuilder`, change the file status update to an atomic `UPDATE ... WHERE status = 'ready' RETURNING *` using `$queryRaw`. This makes the status transition the ownership claim, not the batch creation.

---

## 5. Batch Lifecycle

### 5.1 Connectivo acknowledges but never sends results (status: `processing` forever)
**❌ Design flaw**
No timeout exists. Files in `processing` status are ineligible for the retry job and will never be re-queued. The batch stays open indefinitely.

**Fix:** The retry job should detect batches where `status = 'processing' AND acknowledged_at < NOW() - interval '2 hours'`, reset them to `pending`, and reset their files to `ready`. Connectivo can re-acknowledge on its next poll.

---

### 5.2 Connectivo sends partial results (some files missing from response)
**❌ Design flaw**
`RemediationService` only updates files that appear in the response. Files absent from the payload stay in `processing` forever.

**Fix:** After processing the response, any `batch_files` whose `connectivo_state` is still `null` should be marked as `failed` with `error_message = 'Missing from Connectivo response'` and made eligible for retry.

---

### 5.3 Connectivo never polls (batch stays `pending` forever)
**⚠️ Assumption**
No timeout on `pending` batches. Acceptable for now — if Connectivo stops polling, the issue is operational. An alert on batch age would be a useful addition later.

---

### 5.4 All files in a course fail S3 upload
**✅ Handled**
`SyncOrchestrator` only creates a batch if there are `ready` files. No batch = no Connectivo call. Files are marked `failed` and picked up by the retry job.

---

## 6. Retry Mechanism

### 6.1 Retry job picks up a file that failed S3 upload (no `s3_source_key`)
**❌ Design flaw**
The retry job resets `failed` files to `ready` and batches them. But a file that failed during S3 upload has no `s3_source_key`. Connectivo would receive an empty key and fail again.

**Fix:** Introduce two distinct failure paths:
- `s3_upload_failed` — needs re-download and re-upload before batching
- `remediation_failed` — already in S3, just needs re-batching

The retry job handles each differently: re-upload for the first, direct re-batch for the second.

---

### 6.2 File modified while waiting in the retry queue (status: `failed`)
**✅ Handled**
`FileChangeDetector` detects the change → resets to `pending`, clears retry counters. The file bypasses the retry queue and goes through the normal sync path with the new content.

---

## Summary

| # | Scenario | Status |
|---|---|---|
| 1.1 | New file | ✅ |
| 1.2 | Content modified | ✅ |
| 1.3 | Metadata-only change | ✅ |
| 1.4 | File deleted | ✅ |
| 1.5 | Deleted then re-uploaded | ✅ |
| 1.6 | Wrong MIME type | ✅ |
| 1.7 | Locked / hidden file | ⚠️ Assumption |
| 2.1 | File added between syncs | ✅ |
| 2.2 | File added during a sync run | ✅ |
| 2.3 | Silent empty response from Canvas | ⚠️ Partial |
| 2.4 | Stale `lastSyncedAt` | ✅ Manual recovery |
| 3.1 | Modified before Connectivo | ✅ |
| 3.2 | Modified while Connectivo processing | ✅ |
| 3.3 | Modified multiple times during processing | ✅ |
| 3.4 | Writeback loop | ✅ |
| 4.1 | Modified while `failed` | ✅ |
| 4.2 | Modified while `permanently_failed` | ❌ |
| 4.3 | Stuck in `uploading_to_s3` after crash | ❌ |
| 4.4 | Concurrent syncs, duplicate batching | ❌ |
| 5.1 | Connectivo never sends results | ❌ |
| 5.2 | Connectivo sends partial results | ❌ |
| 5.3 | Connectivo never polls | ⚠️ Assumption |
| 5.4 | All files fail S3 upload | ✅ |
| 6.1 | Retry picks up file with no S3 key | ❌ |
| 6.2 | Modified while in retry queue | ✅ |

**6 design flaws** need fixing: 4.2, 4.3, 4.4, 5.1, 5.2, 6.1.
