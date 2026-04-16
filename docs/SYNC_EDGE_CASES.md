# Sync Edge Cases

Edge cases in the sync and remediation pipeline, and how the current timestamp-based model handles them. See `FILE_STATUSES.md` for the underlying state model.

Status key: ✅ Handled · ⚠️ Partial / assumption · ❌ Unresolved

---

## 1. File discovery

### 1.1 New file added to Canvas — ✅
Detector finds no existing row → inserts with a fresh `discovered_modified_at` → upload queued → batched.

### 1.2 File content modified between syncs — ✅
Canvas `modified_at` advances → detector bumps `discovered_modified_at` and clears `last_outcome` → upload queued → new content-addressed S3 key (old version preserved) → re-batched.

### 1.3 Metadata-only change (rename, move) — ✅
Canvas only bumps `modified_at` on content change; our detector keys off `modified_at`, so metadata churn is ignored by design.

### 1.4 File deleted from Canvas — ✅
After listing, detector cross-references with the DB. Missing files get `last_outcome = 'deleted'`. **Mass-delete guard:** if Canvas returns zero files *and* we have existing rows for the course, we abort the course sync without marking anything deleted — this prevents an API blip from wiping the course.

### 1.5 File deleted then re-uploaded — ✅
Canvas assigns a new file id; we treat it as brand new.

### 1.6 Wrong MIME type (`application/octet-stream`) — ✅
Server-side `content_types[]` filter plus a client-side extension check.

### 1.7 Locked or hidden in Canvas — ⚠️ Assumption
We process them as normal. Add a `file.locked` filter in `CanvasFileFetcher` if an institution needs them skipped.

---

## 2. Incremental sync / timing

### 2.1 File uploaded between two sync runs — ✅
Standard incremental case.

### 2.2 File uploaded *during* a sync run — ✅
`lastSyncedAt` is stamped at **sync start**, so the file is picked up on the next run at worst.

### 2.3 Canvas silently returns an empty list — ✅
Combined with the 1.4 mass-delete guard, an empty response never causes deletion. `?force=true` is available for manual recovery.

### 2.4 Stale `lastSyncedAt` — ✅
`POST /api/v1/sync/institutions/:id?force=true` clears `lastSyncedAt` and rewinds `discovered_modified_at` so every file is reconsidered.

---

## 3. Modification during remediation

### 3.1 Modified before it reaches Connectivo — ✅
Detector bumps `discovered_modified_at`. Upload worker re-uploads; BatchBuilder picks it up via `batched_modified_at < s3_source_modified_at`.

### 3.2 Modified *while Connectivo is processing* — ✅
Same mechanism: `discovered_modified_at` advances past `batched_modified_at`. When Connectivo returns results for the *old* version, they're recorded as a terminal outcome, and BatchBuilder immediately re-batches the newer version on the next pass because `batched_modified_at` is still the old value. No `pending_resubmit` flag needed.

### 3.3 Modified multiple times during processing — ✅
`discovered_modified_at` is always the latest value; whatever is in S3 at batching time is what gets sent next.

### 3.4 Writeback loop — ✅
`last_writeback_modified_at` is consulted by the detector; exact-ms equality skips our own writebacks.

---

## 4. State transitions

### 4.1 Failed file has content change — ✅
Detector bumps `discovered_modified_at` and clears `last_outcome` + retry counters → treated as fresh.

### 4.2 `permanently_failed` file has content change — ✅
Same path as 4.1: content change clears `last_outcome` regardless of what it was. The old terminal outcome was for old content, so it's right to give the new content a fresh attempt.

### 4.3 Server crashes mid-upload — ✅
There is no transient "uploading" status to get stuck in. An interrupted upload simply leaves `s3_source_modified_at` behind `discovered_modified_at`, and any subsequent discovery or retry pass picks the file back up. The Canvas pre-signed URL is re-fetched by the upload worker before each attempt, so expiry during queue wait is also handled.

### 4.4 Concurrent batching of the same file — ✅
BatchBuilder claims files with an atomic `UPDATE … WHERE batched_modified_at IS NULL OR batched_modified_at < s3_source_modified_at`. Two racing builders cannot both claim the same version.

---

## 5. Batch lifecycle

### 5.1 Connectivo acknowledges but never submits results — ❌ Unresolved
Nothing currently times out a `processing` batch. Planned fix: retry job resets batches where `status = 'processing' AND acknowledged_at < NOW() - interval '2 hours'` back to `pending` and clears `batched_modified_at` on their files so BatchBuilder re-claims them.

### 5.2 Partial results (some files missing) — ✅
`RemediationService` marks any `batch_file` absent from the payload as `failed` with `error_message = 'Missing from Connectivo response'`, and writes `last_outcome = 'failed'` on the source file so it becomes retry-eligible.

### 5.3 Connectivo never polls — ⚠️ Assumption
No timeout on `pending` batches. Operational concern; add a batch-age alert later.

### 5.4 All files in a course fail S3 upload — ✅
No ready files → no batch. Files are retry-eligible via the retry job.

### 5.5 Duplicate result POST from Connectivo — ✅
Replaying `POST /results` with the same `connectivo_batch_id` on an already-terminal batch returns 200 as a no-op. Replaying acknowledgement is similarly idempotent.

---

## 6. Retry

### 6.1 Retry picks up a file with no S3 key — ✅
`RetryService` splits eligible failed files: those missing `s3_source_key` go back on the upload queue; those with an S3 key have `batched_modified_at` cleared and are fed to BatchBuilder directly.

### 6.2 Modified while in retry queue — ✅
Content change clears `last_outcome` and retry counters; the file re-enters the normal path with the new content.

### 6.3 Retry cadence — ⚠️ Daily only
Retries are driven by the daily sweep (EventBridge in prod). Local dev has no scheduled sweep — trigger manually by POSTing to the sync routes (or by enqueueing a `{type:'sweep'}` message via a REPL). A file that fails at 3am in prod waits until ~2am the next day for another attempt unless its Canvas content changes first. Acceptable for accessibility workloads; if faster retries become important, add a second EventBridge rule firing every N hours that also enqueues a `sweep` message.

---

## 7. Cross-institution authorisation

### 7.1 Scoped API key attempts another institution's batch — ✅
`apiKeyAuth` attaches `{ id, institutionId }` to `res.locals`. Routes enforce that `batch.institutionId === authInstitutionId` (or the key is global, `institutionId = NULL`) before acknowledging or accepting results.

---

## Summary

| # | Scenario | Status |
|---|---|---|
| 1.1 | New file | ✅ |
| 1.2 | Content modified | ✅ |
| 1.3 | Metadata-only change | ✅ |
| 1.4 | File deleted (with mass-delete guard) | ✅ |
| 1.5 | Deleted then re-uploaded | ✅ |
| 1.6 | Wrong MIME type | ✅ |
| 1.7 | Locked / hidden | ⚠️ |
| 2.1 | Added between syncs | ✅ |
| 2.2 | Added during a sync | ✅ |
| 2.3 | Silent empty response | ✅ |
| 2.4 | Stale `lastSyncedAt` | ✅ |
| 3.1 | Modified before Connectivo | ✅ |
| 3.2 | Modified during Connectivo processing | ✅ |
| 3.3 | Modified multiple times | ✅ |
| 3.4 | Writeback loop | ✅ |
| 4.1 | Modified while failed | ✅ |
| 4.2 | Modified while permanently_failed | ✅ |
| 4.3 | Crash mid-upload | ✅ |
| 4.4 | Concurrent batching | ✅ |
| 5.1 | Connectivo never returns results | ❌ |
| 5.2 | Partial results | ✅ |
| 5.3 | Connectivo never polls | ⚠️ |
| 5.4 | All S3 uploads fail | ✅ |
| 5.5 | Duplicate result POST | ✅ |
| 6.1 | Retry with no S3 key | ✅ |
| 6.2 | Modified in retry queue | ✅ |
| 7.1 | Cross-institution auth | ✅ |

**One unresolved flaw:** 5.1 (stuck `processing` batches). Operational for now; retry-job fix is planned.
