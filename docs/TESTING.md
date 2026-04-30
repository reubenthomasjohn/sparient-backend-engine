# Manual Test Plan — Writeback

Manual test recipes for the post-remediation writeback feature. Each case is independent and idempotent — run in any order. Cases assume a working sync pipeline (institution registered, courses discovered, files uploaded, at least one batch published).

There's a section at the end on what's worth automating and how.

---

## Setup

### Prerequisites
- Server running locally (`npm run dev`) OR deployed to dev (Lambdas in `us-east-2`).
- An institution row in the DB with valid Canvas credentials and `writeback_opt_in = true`.
- At least one course with files that have real accessibility issues (so Connectivo produces non-trivial remediations).
- A test Canvas course you can clobber — writebacks overwrite the file in place.
- Postman with the bundled collection (`sparient.postman_collection.json`).

### Useful tools
- **Prisma Studio** (`npm run db:studio`) — direct DB inspection.
- **psql** against `DATABASE_URL` — for the SQL snippets below.
- **AWS Console / aws cli** — inspect S3 buckets and SQS queues.
- **Canvas UI** — verify file replacement landed.
- **Local logs** (`npm run dev`) or CloudWatch (`/aws/lambda/sparient-dev-*`).

### Reset between tests
```bash
# Wipe all course/file/batch data for the test institution. Institution row stays.
curl -X DELETE http://localhost:3000/api/v1/institutions/<institutionId>/data
```

### Helpful SQL snippets
```sql
-- Resolved opt-in for a course
SELECT c.id, c.writeback_opt_in AS course_opt_in, i.writeback_opt_in AS inst_opt_in,
       COALESCE(c.writeback_opt_in, i.writeback_opt_in) AS resolved
FROM courses c JOIN institutions i ON c.institution_id = i.id
WHERE c.id = '<courseId>';

-- Writeback state for a source_file
SELECT id, canvas_file_id, writeback_state, last_writeback_modified_at,
       discovered_modified_at, batched_modified_at
FROM source_files WHERE id = '<sourceFileId>';

-- Batch file outcome + writeback eligibility
SELECT bf.id, bf.connectivo_state, bf.quality_label,
       bf.remediated_s3_key, bf.remediated_s3_bucket,
       bf.review_acknowledged, bf.source_modified_at
FROM batch_files bf WHERE bf.batch_id = '<batchId>';
```

---

## Test cases

### Happy path

#### T1 — Single completed file is written back to Canvas

**Goal:** End-to-end happy path.

**Setup:**
1. Pick a Canvas course with one file that has fixable issues.
2. Set `institution.writeback_opt_in = true`.
3. Confirm the file is in a supported MIME type (PDF/docx/pptx/xlsx).

**Steps:**
1. `POST /api/v1/sync/institutions/<institutionId>?force=true`
2. Wait for the SFN execution to complete and Connectivo to write `response.json`.

**Expected:**
- `batch_files.connectivo_state = 'completed'` (or `'completed_with_warnings'`)
- `batch_files.remediated_s3_key` is non-null and starts with `connectivo-remediated/`
- `source_files.writeback_state = 'written'`
- `source_files.last_writeback_modified_at` is set to a recent timestamp
- The file in Canvas now has the remediated PDF as content (Canvas file id is preserved)
- Logs show: `Writeback: written to Canvas`

**Verify:**
- DB query in *Helpful SQL snippets*.
- Open Canvas → the file → preview should show the remediated version.
- `aws s3 ls s3://<institution-bucket>/connectivo-remediated/` shows the PDF.

---

### Opt-in gating

#### T2 — Institution opt-out blocks writeback

**Setup:** `UPDATE institutions SET writeback_opt_in = false WHERE id = '<id>';` Course's `writeback_opt_in` is NULL (no override).

**Steps:** Trigger sync as in T1.

**Expected:** Batch goes terminal, `writeback_state` stays NULL on every source_file. Logs show `RemediationService: writeback skipped — opt-out`. Canvas file unchanged.

#### T3 — Course override beats institution opt-out

**Setup:** `institution.writeback_opt_in = false`, `course.writeback_opt_in = true`.

**Steps:** Sync as in T1.

**Expected:** Writeback fires for files in that course only. Other courses (where `course.writeback_opt_in IS NULL`) do not write back.

#### T4 — Course override beats institution opt-in (negative)

**Setup:** `institution.writeback_opt_in = true`, `course.writeback_opt_in = false`.

**Steps:** Sync as in T1.

**Expected:** That course gets no writebacks; other courses do.

---

### Quality label and connectivo state behavior

#### T5 — `qualityLabel = 'Failed'` still gets written back

Per current design, the ack flag is UI-only and writeback is not gated on quality. Confirm this hasn't regressed.

**Setup:** Need a file Connectivo will mark `Failed` (one with unresolvable issues). Or hand-edit a `batch_files.quality_label = 'quality_failed'` and replay the response (T13 mechanism).

**Expected:** `writeback_state = 'written'`. The PDF is pushed back even though quality is Failed.

#### T6 — `connectivoState = 'failed'` does NOT write back

**Setup:** A file Connectivo can't process. Or hand-edit `batch_files.connectivo_state = 'failed'`, `remediated_s3_key = NULL` and replay.

**Expected:** No writeback enqueued for that file. `source_files.writeback_state` stays NULL.

#### T7 — `connectivoState = 'completed_with_warnings'` writes back

**Expected:** Same as T1.

---

### Supersession and Canvas-side drift

#### T8 — File edited in Canvas during remediation → writeback skipped

**Goal:** Verify the optimistic concurrency check (`isCanvasFileEligibleToReplace`).

**Setup:** Trigger sync. While Connectivo is still processing, manually edit/replace the file in Canvas (upload a new version). Wait for Connectivo's `response.json` to arrive.

**Expected:**
- The writeback worker's call to `replaceFile` returns `{ status: 'skipped', reason: 'modified' }`.
- `source_files.writeback_state = 'skipped_stale'`.
- Canvas file is **unchanged** (the teacher's edit wins).
- Logs show: `Canvas: skipping replace — file was modified in Canvas after our sync`.

#### T9 — File deleted from Canvas during remediation

**Setup:** Same as T8 but delete the file in Canvas instead of editing.

**Expected:** `replaceFile` returns `{ status: 'skipped', reason: 'deleted' }`. `writeback_state = 'skipped_stale'`. No 500 error.

#### T10 — Newer batch supersedes an older writeback

**Goal:** Confirm the producer's supersession filter doesn't enqueue stale jobs.

**Setup:**
1. Trigger sync (cycle 1). Wait for batch published, but BEFORE response.json arrives.
2. Bump `discovered_modified_at` in the DB (`UPDATE source_files SET discovered_modified_at = NOW() WHERE id = '<id>';`) and trigger another sync — cycle 2 batches a newer version.
3. Manually replay cycle 1's old response: `POST /api/v1/admin/responses/<institutionId>/<courseId>/<cycle1BatchId>`.

**Expected:** `enqueueWritebacks` runs for cycle 1 but the producer filter skips every file (`sourceFile.batchedModifiedAt != batchFile.sourceModifiedAt`). Logs show `count: 0`. No SQS messages.

---

### Idempotency and re-delivery

#### T11 — Re-process the same response.json (no duplicates)

**Goal:** Confirm dedupe filter prevents re-uploading after a successful writeback.

**Setup:** Run T1 to completion.

**Steps:** Replay the same response.json: `POST /api/v1/admin/responses/<institutionId>/<courseId>/<batchId>`.

**Expected:**
- The batch is already terminal → `RemediationService` logs `batch already terminal, re-checking writeback enqueue` and calls `enqueueWritebacks`.
- The dedupe filter fires (`writeback_state = 'written'` AND `last_writeback_modified_at > sourceModifiedAt`) → `count: 0` in the enqueue log.
- No new Canvas API calls. `last_writeback_modified_at` unchanged.

#### T12 — Crash-recovery: simulate partial enqueue

**Goal:** Confirm a re-delivered response after a partial enqueue catches up the rest.

**Setup:** Hand-edit one source_file's `writeback_state = 'written'` and `last_writeback_modified_at = <a timestamp later than batch_file.source_modified_at>` to simulate "this one was enqueued + processed before the crash".

**Steps:** Replay the response: `POST /api/v1/admin/responses/.../<batchId>`.

**Expected:** Producer dedupes the pre-stamped file, enqueues the rest. Each remaining file's `writeback_state` flips to `'written'`.

#### T13 — All-fail throw

**Goal:** Confirm we throw (instead of silently succeeding) when every send fails.

**Setup:** This is hardest to reproduce locally. One option: in dev, swap the `writebackQueue` for a stub that throws on every `send`, run a full sync. Or temporarily break the SQS URL in `SQS_WRITEBACK_URL`.

**Expected:** `enqueueWritebacks` throws after the loop completes (`Writeback enqueue partially failed for batch ... sent=0 failed=N`). The responses Lambda returns the message as an item failure → SQS redrives → next attempt enqueues normally.

---

### Writeback loop guard

#### T14 — A successful writeback does NOT trigger a fresh remediation cycle

**Goal:** `FileChangeDetector` must skip our own writebacks.

**Setup:** Run T1 to completion. Note the new `last_writeback_modified_at` value.

**Steps:** Trigger another sync: `POST /api/v1/sync/institutions/<id>` (no `?force=true`).

**Expected:** `FileChangeDetector` sees the file's Canvas-side `modified_at` exactly equals `last_writeback_modified_at` and skips it. No new batch_file. No re-upload to S3. Logs show no entry for this file in `toUploadJobs`.

**Watch out for:** if the next sync DOES re-process the file, that's the precision-drift bug noted in `docs/TODO.md`. Capture the two timestamps from logs and file an issue.

---

### Ack endpoint

#### T15 — Ack flips the flag, no pipeline side effects

**Steps:**
```bash
curl -X POST http://localhost:3000/api/v1/batches/<batchId>/files/<batchFileId>/acknowledge
```

**Expected:**
- 200 with `{ success: true }`.
- `batch_files.review_acknowledged` flips from `false` to `true`.
- No queue activity, no Canvas calls, no other column changes.
- Idempotent: a second call still returns 200.

#### T16 — Ack mismatched batchId → 404

**Steps:** POST with the right `batchFileId` but a wrong `batchId` in the URL.

**Expected:** 404 (not 200). `review_acknowledged` unchanged.

#### T17 — Ack non-existent batchFile → 404

**Expected:** 404.

---

### Edge cases on Connectivo's response

#### T18 — Partial response (file missing from `folders[].files[]`)

**Goal:** Files Connectivo silently dropped should be marked failed, not silently completed.

**Setup:** Hand-edit a `response.json` in S3 to remove one file's entry. Then `POST /api/v1/admin/responses/<inst>/<course>/<batch>`.

**Expected:**
- The missing file's `batch_files.connectivo_state = 'failed'`, `error_message = 'Missing from Connectivo response'`.
- That file's `source_files.last_outcome = 'failed'` (retry-eligible).
- No writeback enqueued for that file.
- The other files in the batch DO get written back.

#### T19 — Malformed `remediated_path`

Test the `stripBucketFromPath` edge cases:

| Input `remediated_path`          | Stored `remediated_s3_key` | Writeback enqueued? |
|----------------------------------|----------------------------|---------------------|
| `/bucket/connectivo-remediated/foo.pdf` | `connectivo-remediated/foo.pdf` | yes |
| `//bucket/connectivo-remediated/foo.pdf` | `connectivo-remediated/foo.pdf` | yes |
| `/bucket/`                       | `null` | no (logged warning) |
| `bucket-only`                    | `null` | no (logged warning) |
| `null`                           | `null` | no |

**Setup:** Hand-craft a response.json variant per row, replay via the admin endpoint.

#### T20 — Duplicate response delivery within seconds

**Goal:** Two S3 events within seconds (Connectivo wrote twice) → both processed, only one effect.

**Setup:** Manually `POST /api/v1/admin/responses/...` twice in quick succession against the same batchId.

**Expected:** Second call hits the terminal-status branch and re-runs `enqueueWritebacks` with `count: 0` (everything already written). No double Canvas writes.

---

### Failure-mode tests

#### T21 — Canvas API 500 during writeback

**Setup:** Easiest local reproduction: temporarily change the Canvas `domain` in the institution row to a host that returns 500 (or a non-existent host). Then trigger a fresh sync.

**Expected:**
- Writeback worker throws.
- `source_files.writeback_state = 'failed'` (via the handler's guarded `updateMany`).
- SQS redrives up to `maxReceiveCount` (3) times → eventually goes to the DLQ.
- After fixing the domain and replaying the response, the file is enqueued again (`writeback_state = 'failed'` is one of the `OR` conditions in the dedupe).

#### T22 — S3 remediated PDF missing

**Setup:** Wait for a successful writeback to be enqueued, then `aws s3 rm` the remediated PDF before the worker picks it up. (Tighten the SQS visibility window if needed.)

**Expected:** Worker throws on `getObjectBytes` (`NoSuchKey`). `writeback_state = 'failed'`. SQS redrives.

#### T23 — Worker crashes mid-execution (in-memory queue, dev only)

**Setup:** Local dev with `InMemoryQueue`. Send SIGTERM to the server while a writeback is in flight.

**Expected:** Job is dropped (no SQS in dev). On next server startup + a manual response replay, the file re-enqueues because dedupe doesn't fire (`writeback_state` may still be NULL).

---

## Should we automate any of this?

Yes, and the system is more amenable to it than it looks. Recommended split:

### Unit tests (high value, fast)

The pure-logic seams worth covering with mocked dependencies:

| Module | What to test | Mocks |
|--------|--------------|-------|
| `WritebackService` | Eligibility branches (terminal state, opt-in, supersession, key/bucket null), `replaced` vs `skipped` paths, guarded `updateMany` writes | `prisma`, `SourceRegistry.getClient` |
| `RemediationService.enqueueWritebacks` | Filter logic (opt-in, dedupe via `lastWritebackModifiedAt > sourceModifiedAt`, supersession), throw-on-partial-fail, idempotent re-runs | `prisma`, `writebackQueue.send` |
| `RemediationService.handleResults` | State transitions on completed/failed/missing files, terminal-batch early-return path that still calls enqueue | `prisma`, `enqueueWritebacks` |
| `stripBucketFromPath` | All the edge cases in T19 | None — pure function |
| `FileChangeDetector.detect` | New file, content change, metadata-only, deletion, mass-delete guard, writeback-loop skip | `prisma` |
| `BatchBuilder.buildForCourse` | Atomic claim, no-eligible-files no-op, publish-failure rollback | `prisma`, `requestPublisher.publish` |
| `CanvasFileReplacer` | Eligible/ineligible/deleted branches, single-fetch optimisation, `supersedeFile` deletes only after upload succeeds | `CanvasClient`, `s3Service` |
| `computeFailureUpdate` | Backoff math at each retry boundary | None |

**Stack to add:**
- `vitest` (faster, simpler than jest, works with TS out of the box)
- `vitest-mock-extended` or `prisma-mock` for prisma
- `nock` for axios/Canvas calls
- `aws-sdk-client-mock` for S3 and SQS clients

### Integration tests (medium value, slower)

End-to-end through the real DB, with external systems stubbed. Use `@testcontainers/postgresql` to spin up an ephemeral Postgres per suite.

| Flow | Scenario | Stubs |
|------|----------|-------|
| Discovery → batch | Canvas returns N files → DB gets N source_files + 1 batch with N batch_files + 1 request.json in S3 | Canvas API (`nock`), S3 (`aws-sdk-client-mock`) |
| Response → outcomes | Drive `handleResults` with a fixture response.json → DB has correct outcomes + writeback queue has eligible jobs | S3 (`aws-sdk-client-mock`), `writebackQueue.send` (spy) |
| Writeback → Canvas | Drive `handleWritebackJob` → Canvas mock receives an upload + DB has `writeback_state = 'written'` | Canvas API, S3 |
| Re-delivery idempotency | Run `handleResults` twice for the same batch → only one writeback enqueued | Same as above |
| Supersession | Cycle 1 batched, cycle 2 batched (newer), cycle 1 response arrives → no writebacks enqueued | Same as above |

### Out of scope for automation

- **Real Canvas / real Connectivo end-to-end.** Their behavior, rate limits, and timing are too noisy for CI. Keep these as the manual cases above.
- **AWS SFN + SQS retry semantics.** Lambda + SFN integration is best validated in dev AWS via the manual cases (T8, T13). Mocking SFN faithfully is more work than it's worth.

### Suggested progression

1. Start with **unit tests for `WritebackService` and `RemediationService.enqueueWritebacks`** — they're the most logic-dense and the easiest to mock. Will catch most regressions in the writeback feature directly.
2. Add **`stripBucketFromPath` + `computeFailureUpdate`** — trivial pure-function tests, instant ROI.
3. Once unit tests are running in CI, add **one integration test per flow** (discovery, response, writeback) — these are the regression-killers.
4. Skip everything else until something actually breaks twice.

The first two together would take a half-day. Worth it before we ship writeback to a real institution.
