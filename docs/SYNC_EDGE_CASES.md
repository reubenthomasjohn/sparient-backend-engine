# Sync Edge Cases

Edge cases in the sync and remediation pipeline, and how the current timestamp-based model handles them. See `FILE_STATUSES.md` for the underlying state model.

Status key: ✅ Handled · ⚠️ Partial / assumption · ❌ Unresolved

---

## 1. File discovery

### 1.1 New file added to Canvas — ✅
Detector finds no existing row → inserts with a fresh `discovered_modified_at` → uploaded via SFN Map → batched.

### 1.2 File content modified between syncs — ✅
Canvas `modified_at` advances → detector bumps `discovered_modified_at` and clears `last_outcome` → re-uploaded → new content-addressed S3 key (old version preserved) → re-batched.

### 1.3 Metadata-only change (rename, move) — ✅
Canvas only bumps `modified_at` on content change; our detector keys off `modified_at`, so metadata churn is ignored by design.

### 1.4 File deleted from Canvas — ✅
After listing, detector cross-references with the DB. Missing files get `last_outcome = 'deleted'`. Two guards prevent over-eager deletion:
- **Mass-delete guard:** if Canvas returns zero files *and* we have existing rows for the course, we abort the course sync without marking anything deleted — this prevents an API blip from wiping the course.
- **In-scope guard:** rows whose stored `mimeType` is no longer in the institution's current `allowedMimeTypes` (e.g. the institution narrowed `syncConfig.allowedFileTypes`) are excluded from the deletion check. They're out of scope, not deleted from Canvas; if the institution later re-widens the allowlist, the reappear-after-deleted path picks them back up.

### 1.5 File deleted then re-uploaded — ✅
Canvas assigns a new file id; we treat it as brand new.

### 1.6 Wrong MIME type (`application/octet-stream`) — ✅
Server-side `content_types[]` filter plus a client-side extension check.

### 1.7 Locked or hidden in Canvas — ✅ Configurable
Default behavior is to process them as normal (open by default). To skip them, PATCH the institution's `syncConfig` with `skipLockedFiles: true` and/or `skipHiddenFiles: true`. The filter is applied in `CanvasSourceClient.getFiles()`; excluded files never enter the pipeline. See `src/services/sync/syncConfig.ts` for the full per-institution config.

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
Detector bumps `discovered_modified_at`. SFN re-uploads; BatchBuilder picks it up via `batched_modified_at < s3_source_modified_at`.

### 3.2 Modified *while Connectivo is processing* — ✅
Same mechanism: `discovered_modified_at` advances past `batched_modified_at`. When Connectivo returns results for the *old* version, they're recorded as a terminal outcome, and BatchBuilder re-batches the newer version on the next pass because `batched_modified_at` is still the old value.

### 3.3 Modified multiple times during processing — ✅
`discovered_modified_at` is always the latest value; whatever is in S3 at batching time is what gets sent next.

### 3.4 Writeback loop — ✅
`last_writeback_modified_at` is consulted by the detector; exact-ms equality skips our own writebacks.

---

## 4. State transitions

### 4.1 Failed file has content change — ✅
Detector bumps `discovered_modified_at` and clears `last_outcome` + retry counters → treated as fresh.

### 4.2 `permanently_failed` file has content change — ✅
Same path as 4.1: content change clears `last_outcome` regardless of what it was.

### 4.3 Crash mid-upload — ✅
If a Step Functions upload step fails, SFN retries it (2 attempts, 30s backoff). If all retries fail, the batch-publish step still runs — the file stays with `s3_source_modified_at` behind `discovered_modified_at` and will be re-uploaded on the next discover pass.

### 4.4 Concurrent batching of the same file — ✅
BatchBuilder claims files with an atomic `UPDATE … WHERE batched_modified_at IS NULL OR batched_modified_at < s3_source_modified_at`. Two racing builders cannot both claim the same version. Step Functions guarantees one batch per course per sync pass (no split batches).

---

## 5. Batch lifecycle

### 5.1 Connectivo never writes a response — ⚠️ Detectable
The `GET /api/v1/batches/stuck?olderThanHours=24` endpoint finds pending batches with `request_written_at` older than N hours. Currently observability-only; no automated remediation.

### 5.2 Partial results (some files missing) — ✅
`RemediationService` marks any `batch_file` absent from the payload as `failed` with `error_message = 'Missing from Connectivo response'`, and writes `last_outcome = 'failed'` on the source file so it becomes retry-eligible.

### 5.3 Connectivo never polls — ⚠️ Detectable
Same as 5.1 — the stuck-batch endpoint catches this.

### 5.4 All files in a course fail S3 upload — ✅
SFN Map state returns all failures. Batch-publish step still runs but finds no eligible files → no batch created. Files remain retry-eligible for the next discover pass.

### 5.5 Duplicate response from Connectivo — ✅
If Connectivo re-writes the response.json, S3 fires another event. The responses Lambda processes it and calls `RemediationService`, which sees the batch is already terminal and returns a no-op.

### 5.6 Request publish fails — ✅
BatchBuilder rolls back the claim (`batchedModifiedAt = null`, batch status `failed`). Files become eligible for the next batch. As a safety net, `releaseStuckBatches` in the batch-publish step catches any batch with `requestWrittenAt = null`.

---

## 6. Retry

### 6.1 Retry picks up a file with no S3 key — ✅
The batch-publish step of the course workflow checks for retry-eligible failed files. Those missing `s3_source_key` will be picked up by the next discover-files → upload cycle. Those with an S3 key have `batched_modified_at` cleared so BatchBuilder re-claims them.

### 6.2 Modified while waiting for retry — ✅
Content change clears `last_outcome` and retry counters; the file re-enters the normal path with the new content.

### 6.3 Retry cadence — ✅
Retries happen during each course discover pass (the batch-publish step retries failed files for that course). The tick fires every 15 min; an institution is synced daily at its configured `sync_time`. Content changes trigger immediate re-processing regardless of retry state.

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
| 1.7 | Locked / hidden | ✅ |
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
| 5.1 | Connectivo never returns results | ⚠️ Detectable |
| 5.2 | Partial results | ✅ |
| 5.3 | Connectivo never polls | ⚠️ Detectable |
| 5.4 | All S3 uploads fail | ✅ |
| 5.5 | Duplicate response | ✅ |
| 5.6 | Request publish fails | ✅ |
| 6.1 | Retry with no S3 key | ✅ |
| 6.2 | Modified in retry queue | ✅ |
| 6.3 | Retry cadence | ✅ |
