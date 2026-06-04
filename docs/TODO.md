# TODO

## HIGH PRIORITY (#1) — Single-file sync trigger endpoint

Parity with the per-course sync trigger (`POST /api/v1/sync/institutions/:institutionId/courses/:canvasCourseId`). A user (Canvas LTI / admin UI) needs to trigger remediation for one specific file on demand, without waiting for the next scheduled sync window.

**Endpoint:**
```
POST /api/v1/sync/institutions/:institutionId/courses/:canvasCourseId/files/:canvasFileId?force=true
```

Hierarchy mirrors the existing per-course endpoint. `canvasCourseId` and `canvasFileId` are Canvas's external IDs (matching the URL convention already in use); `institutionId` is our internal UUID.

**Body:** none required. `?force=true` re-processes even if `discoveredModifiedAt` is unchanged (default for this endpoint should probably be `force=true` — if the user clicked "remediate this file" they expect *something* to happen).

**Behavior:**
1. Resolve the institution + course rows. 404 if either doesn't exist.
2. Refresh the file via `sourceClient.getFile(canvasCourseId, canvasFileId)`.
   - 404 from Canvas → return 404 to caller (don't mark deleted on a one-shot trigger; that's the discovery flow's job).
   - Unsupported file type per `syncConfig.allowedFileTypes` → return 400 with a clear message naming the type and the institution's allowed list.
   - File exceeds `syncConfig.maxFileSizeBytes` (if set) → 400.
   - File is locked/hidden AND institution opted to skip those → 400.
3. Upsert the `source_file` row. Bump `discoveredModifiedAt` if Canvas reports newer or `?force=true`. Clear any `lastOutcome: 'deleted'` (reappear path).
4. Run the upload step (decide: inline in the API Lambda OR a tiny SFN execution — see design call below).
5. Run `BatchBuilder.buildForCourse` for that course — picks up the just-uploaded file.
6. Return `{ success: true, batchId, sourceFileId }` for the resulting batch.

**Key design calls:**
- **Step Functions vs inline.** Three options:
  - (A) Extend the existing `course-workflow` SFN with a `singleFileId` input variant that skips the discover-files map and runs upload-file → batch-publish for just that file. Reuses retry/concurrency. Smallest infra change.
  - (B) Add a new `single-file-workflow` SFN. Cleaner separation, more Terraform.
  - (C) Inline in the API Lambda — simplest, but loses SFN's retry + observability. The 30s API timeout also caps how big a file we can handle inline.
  - I lean (A). The existing SFN already supports `singleCourseId`; adding `singleFileId` is a structural variant of the same idea.
- **Race with scheduled sync.** If the file's course is mid-sync when this fires, both could try to claim the file. BatchBuilder's atomic claim handles it — exactly one wins. Worth surfacing in the response that another batch may already be in flight (or returning 409 if so, so the caller knows their file is already being processed).
- **Authorization.** Same model as other sync routes (none on this branch).

**Why this blocks registration:** registration is admin-side onboarding (one-time per tenant). The single-file trigger is the user-facing "remediate this file now" button — likely invoked from a Canvas LTI plugin or admin UI the moment a teacher uploads a file. Without it, customers can only wait for the daily sync window, which is unacceptable for ad-hoc remediation. Ship this first, then ship registration so onboarding can begin without ops involvement.

**Future extension (separate ticket):** a batch-list variant `POST /api/v1/remediate` accepting `[{ institutionId, canvasCourseId, canvasFileId }]` for bulk operations. Useful if a UI ever lets users select N files at once. The single-file endpoint is the more atomic primitive; the batch variant is a thin wrapper.

## HIGH PRIORITY (#2) — Institution registration endpoint

Add `POST /api/v1/institutions`. Currently institutions exist only via `npm run db:seed`. This endpoint is the partner to `PATCH /api/v1/institutions/:id` and is what the frontend will hit to onboard a new tenant.

**Body:**
```jsonc
{
  "name": "Test University",
  "slug": "test-u",
  "sourceType": "canvas",
  "credentials": {
    "domain": "canvas.instructure.com",
    "account_id": "1",
    "api_token": "..."
  },
  "syncTime": "02:00",          // optional, default "02:00" UTC
  "writebackOptIn": false,      // optional, default false
  "syncConfig": null            // optional, default null
}
```

**Behavior:**
1. Validate body with Zod (slug uniqueness, credential format, syncTime HH:MM).
2. Optionally validate the Canvas token by hitting `GET /api/v1/users/self` — return 422 with a clear message if Canvas rejects it.
3. Insert the institution row. **`syncConfig` defaults to null** — null resolves at sync time to the conservative defaults (6 basic file types: pdf/docx/pptx/xlsx/jpg/png; course states `available + unpublished`; no size cap; no locked/hidden skip; no review-ack gate). Customers wanting more types or stricter behavior PATCH after creation.
4. Call `provisionInstitutionBucket(institutionId)` to create + configure the S3 bucket.
5. Return the institution row **without `credentials`** (mirror the PATCH endpoint's safe `select`). Surface non-secret derivative fields like `domain` and `accountId` so the UI can display "connected to ucla.instructure.com."
6. Error rollback: validate-first / write-last pattern — validate Canvas creds, then provision bucket, then insert DB row. Minimizes orphan-state windows.

**Prod credential-storage path** (deferred to its own follow-up): write only the API token to AWS Secrets Manager / SSM (KMS-encrypted), store the secret reference (ARN) on the institution row instead of the plaintext token. Lambdas fetch the secret at cold-start. Aligns with the existing `Prod: fetch DB password from SSM at cold-start` TODO below.

This blocks customer onboarding without ops involvement, so it's the second priority after the single-file trigger.

## Archive support (zip, rar) — deferred

Archives are not currently supported. They were briefly in `FILE_TYPE_REGISTRY` and got pulled because the 1-file-per-Lambda + 1:1 writeback model doesn't fit them. Concrete blockers:

1. **Connectivo contract is unknown.** Does Connectivo unpack `application/zip` and remediate per-entry, or does it reject the file? Need to confirm directly with Connectivo before any further design.
2. **Writeback semantics unclear.** Even if Connectivo unpacks, the writeback step has no concept of "this remediated PDF replaces entry N inside that zip". Two paths:
   - Repack — Connectivo returns a remediated archive, we replace the Canvas file 1:1. Preserves the model, requires Connectivo to support repackaging.
   - Explode — extract each entry server-side as a synthetic `source_file` with `parent_source_file_id`, fan out as N batch_files, push individual remediated PDFs to the Canvas folder (NOT replacing the original archive). Significant schema change + customer-visible structural change.
3. **`CanvasFileReplacer` reads bytes into memory.** A multi-GB archive would OOM the 1024MB Lambda. The streaming TODO below is a prerequisite.
4. **Canvas Inst-FS upload limits** (commonly 250–500MB per file) cap how big a remediated archive can land back, even if (1)–(3) are solved.

When ready to revisit:
- Talk to Connectivo first.
- If they support archive remediation natively, Option A above (repack) is small — re-add `zip`/`rar` to the registry, finish the streaming TODO, ship.
- If they don't, the Option B (explode) path is a real project — schema migration, fan-out, repackaging-or-loose-files decision per institution. Probably 1–2 weeks.

## Replace upload-handler 404 retry-once with a principled retry envelope

`workers/upload/handler.ts` currently does a one-shot 5-second retry when `sourceClient.getFile()` returns null, then marks the file `lastOutcome: 'deleted'` if the second call also 404s. This is a pragmatic fix for the X4-reappear infinite loop (deleted → cleared next sync → upload retries → 404 again → re-deleted), but it's not principled:

- A sustained Canvas blip longer than ~5 seconds still false-deletes.
- Sleeping in a Lambda burns 5s of billed time on the failure path.
- Discovery's cross-reference is the *real* deletion signal, but we duplicate (a worse version of) that detection in the upload worker.

**Better fix:** reroute the 404 case through the existing failure/retry envelope.

1. In the upload handler, on null from `getFile`, call `computeFailureUpdate(row, 'Canvas getFile returned 404 during upload refresh')` and write that — same path as any other upload failure. Don't mark deleted.
2. The discovery flow's `FileChangeDetector` is then the sole source of truth for deletion: if Canvas's course-files listing also omits the file, the detector marks it deleted via cross-reference.
3. **Detector gap to close as part of this work:** today, a row with `lastOutcome` cleared by `retryCourseFiles` (in `batch-publish`) and `s3SourceKey IS NULL` doesn't get re-queued by the next `discoverFiles` (the `isNewer || wasDeleted` predicate doesn't fire because Canvas's `modified_at` is unchanged and `lastOutcome` is null, not `'deleted'`). Add `|| !row.s3SourceKey` to the detector's re-queue predicate so retried-but-never-uploaded files are picked back up.

**Why not now:** the retry-once fix unblocks the X4 loop and is contained to one file. The principled fix touches the detector + the upload handler + needs careful retry-counter accounting. Pick this up if (a) we see real production false-deletes despite the 5s retry, or (b) the next time we touch the upload handler.

## Review remediated_path stripping logic

`RemediationService` strips `/<bucket>/` from Connectivo's `remediated_path` to get the actual S3 key. This assumes Connectivo always prefixes the path with `/<bucket-name>/`. If their format changes, the stripping regex (`/^\/[^/]+\//`) will break. Consider deriving the remediated key from the source key instead (`${S3_PREFIX.REMEDIATED}/${batchFile.s3SourceKey}`), which doesn't depend on Connectivo's path format at all.

## Clean up hardcoded S3 bucket in seed script

`prisma/seed.ts` hardcodes `accesshub-remediation-storage` as the institution's S3 bucket and manually configures the S3 event notification. This was a quick-start shortcut. Once the institution registration endpoint exists, remove the hardcoded bucket from the seed and use `provisionInstitutionBucket` (which creates the bucket + configures notifications dynamically).

## Sync status API endpoint

Add `GET /api/v1/sync/status/:institutionId` — daily monitoring endpoint that queries the DB for a summary of the institution's sync health. More useful than the Step Functions console for daily checks.

```json
{
  "last_synced_at": "2026-04-21T02:00:12Z",
  "courses_total": 3000,
  "today": {
    "batches_created": 8,
    "files_uploaded": 42,
    "files_failed": 1,
    "batches_pending_response": 3,
    "batches_completed": 5
  }
}
```

## Prod: fetch DB password from SSM at cold-start

Currently the full `DATABASE_URL` (including password) is baked into Lambda env vars by Terraform. Acceptable for dev (tfstate is encrypted, Lambda env is IAM-gated). For prod, the Lambda should only receive the SSM parameter *name* as an env var, fetch the password at cold-start, and assemble the connection string in-process. This keeps the password out of the Lambda configuration entirely.

## Prod: tighten GitHub Actions IAM role

The dev CI role has `AdministratorAccess`. For prod, replace with a scoped policy covering only the services Terraform manages (VPC, RDS, SQS, Lambda, ECR, API Gateway, EventBridge, S3, IAM, CloudWatch, Secrets Manager, SSM).

## Switch Lambda to arm64 (Graviton)

Currently using x86_64 because the GitHub Actions free tier (private repos) doesn't include native ARM runners, and QEMU cross-compilation crashes during `npm ci` (Prisma engine binary). Once on a GitHub Pro/Team plan or using self-hosted ARM runners:
- Change `architectures = ["x86_64"]` → `["arm64"]` in both Lambda modules
- Add `linux-arm64-openssl-3.0.x` back to Prisma `binaryTargets`
- Use `ubuntu-24.04-arm` runner in the CI workflow
- Benefit: ~20% cheaper Lambda runtime + ~15% faster cold starts

## Slim down Lambda Docker images

Currently the Dockerfile copies all production `node_modules` into the runtime image (`--packages=external` in esbuild + full `COPY node_modules`). This was done to stop chasing individual missing-module errors from Prisma 7's internal dependencies (`@prisma/client-runtime-utils`, `pg` via `@prisma/adapter-pg`, etc.).

Image size is ~150–200 MB larger than necessary. To slim down:
- Identify the exact set of runtime dependencies Prisma 7 needs (`.prisma/client`, `@prisma/client`, `@prisma/client-runtime-utils`, `@prisma/adapter-pg`, `pg`)
- Switch esbuild back to selectively externalizing only those packages
- Copy only those packages in the Dockerfile instead of all `node_modules`
- Or: use a tree-shaking bundler that can trace Prisma's `require()` graph automatically
- Target: ~100–150 MB image, ~500ms faster cold start

## Enable API Lambda provisioned concurrency

Currently disabled (`api_provisioned_concurrency = 0`) because the AWS account's unreserved concurrency limit is too low (default 10 for new accounts). Provisioned concurrency reserves capacity from this pool, and AWS won't let it drop below 10 unreserved.

**To fix:** request a concurrency limit increase via AWS Support (Service Quotas → Lambda → Concurrent executions). Once approved, set `api_provisioned_concurrency = 1` in `terraform.tfvars`. Cost: ~$5/mo for 1 warm instance at 1 GB. Eliminates cold starts on API requests.

## Prod: switch from Neon to RDS

Dev uses Neon (free, publicly reachable, no VPC needed). For prod, switch to RDS + RDS Proxy inside a VPC. The Terraform modules (`modules/networking`, `modules/database`) are already written — wire them back into the env and add VPC config to the Lambdas. Key changes:
- Re-enable `modules/networking` and `modules/database` in the env's `main.tf`
- Add Lambda SG + VPC subnet config back to all Lambda modules
- Add NAT Gateway (Lambdas need internet access for Canvas API)
- Estimated cost increase: ~$62/mo (RDS $15 + RDS Proxy $15 + NAT $32)

## Stream S3 → Canvas on file replace (instead of buffering)

`CanvasFileReplacer` today reads the full S3 object into memory via `s3Service.getSourceFileBytes` before POSTing to Canvas. Fine for the **default** allowlist (pdf/docx/pptx/xlsx/jpg/png, typically <20MB, one file per Lambda invocation). The expanded registry now includes large image formats (`tiff`); any institution that opts into those via `syncConfig.allowedFileTypes` could push hundred-MB files through a 1024MB Lambda. Plus this work is a prerequisite for ever re-introducing archive support (see *Archive support* above). Until then, document a recommended `syncConfig.maxFileSizeBytes` for institutions opting into TIFF.

**Why streaming is better:**
- Buffering is sequential: download all bytes from S3, *then* upload to Canvas. Time ≈ `t_s3_download + t_canvas_upload`.
- Streaming overlaps them: time ≈ `max(t_s3_download, t_canvas_upload)`. Savings ≈ the faster leg — roughly 20-30% per file in practice (S3 same-region is ~100MB/s, Canvas upload ~25MB/s external).
- Memory at any instant drops from file-size to one chunk (~64KB). Removes any risk of a single huge file OOM'ing a 1024MB Lambda.

**How to switch:**
- Add the `form-data` npm package (native Node `FormData` + `Blob` forces buffering).
- `S3Service.headSourceFile(key)` to get `ContentLength` (Canvas's step 1 needs `size` declared upfront, and Inst-FS requires a `Content-Length` header on step 2 — no chunked transfer).
- `S3Service.getSourceFileStream(key)` returning the `GetObjectCommand` body as a `Readable`.
- In `CanvasClient.finishUpload`, build the multipart with `form-data`: append each `upload_params` field, then `form.append('file', stream, { knownLength, filename, contentType })`. POST to `upload_url` with `form.getHeaders()` + the form as axios body.
- Delete `S3Service.getSourceFileBytes` once nothing else uses it.

**Why not now:** the *default* allowlist keeps files small, each Lambda handles one file in isolation (so concurrency doesn't compound), and the per-file savings are a few hundred ms. Pick this up if (a) any institution opts into TIFF or other large formats via `syncConfig.allowedFileTypes`, (b) archive support is revisited, (c) we see OOMs, or (d) total upload latency becomes a user-visible issue.

## Re-issue `(quality_label, review_acknowledged)` index as CONCURRENTLY for prod

Migration `20260428200000_move_review_acknowledged` creates the `batch_files_quality_label_review_acknowledged_idx` index transactionally — fine on Neon dev (empty table), but a populated prod `batch_files` would block all reads/writes for the duration of the build. Before the first prod deploy that runs against a non-trivial table, drop and re-create as `CREATE INDEX CONCURRENTLY` (in a non-transactional migration, e.g. via the `-- prisma-disable-migrations-transaction` directive once verified against our Prisma version).

## Writeback: post-Canvas-write supersession re-check

`WritebackService` checks supersession (`sourceFile.batchedModifiedAt = batchFile.sourceModifiedAt`) before calling Canvas's `replaceFile`, but does NOT re-check after the call returns. In a narrow race window, a parallel writeback for a *newer* batch on the same `sourceFile` could complete between our check and our post-write update — and our update would then overwrite the newer batch's `lastWritebackModifiedAt` stamp with the older one. The Canvas write itself is idempotent (overwrite by file id), so the bytes are fine; only the bookkeeping is wrong, and `FileChangeDetector` could re-ingest the file as if it were a new edit.

**Fix when this becomes observable:** wrap the post-write `sourceFile.update` in an `updateMany` with `WHERE batchedModifiedAt = batchFile.sourceModifiedAt` so a stale writer no-ops instead of clobbering. Today the writeback queue's bounded concurrency makes this rare; defer until we see it in logs.

## Writeback: verify Canvas `modified_at` precision contract

`FileChangeDetector` uses exact-millisecond equality (`d.modifiedAt.getTime() === row.lastWritebackModifiedAt.getTime()`) to skip our own writebacks. We stamp `lastWritebackModifiedAt` from the Canvas response of the upload. If Canvas's list endpoint serializes timestamps differently from its upload-confirm endpoint (sub-second truncation, rounding), the equality check will silently fail and we'll re-ingest our writebacks as new edits — defeating the loop guard.

We don't currently know whether this drift exists. Watch for it: a `Writeback: written to Canvas` log followed on the next sync pass by a `FileChangeDetector` re-discovery for the same `canvasFileId` is the signature. If observed, switch the equality check to a small tolerance (e.g. `Math.abs(diff) < 1500ms`).

## Surface `qualityLabel = 'Failed'` writebacks in the UI

Writeback currently pushes any `BatchFile` whose `connectivoState IN ('completed', 'completed_with_warnings')` and has a `remediatedS3Key`, regardless of `qualityLabel`. That means files Connectivo flagged as quality-`Failed` (or `RequiresReview`) are still pushed back to Canvas — by design, since `reviewAcknowledged` is purely a tracking flag, not a gate.

Surface a UI distinction so users can see which writebacks landed despite a `Failed`/`RequiresReview` quality label and choose to roll them back or supersede them. No backend gating change required — just a query on `batch_files` filtered by `qualityLabel` and `writebackState='written'`.

## On-demand file remediation

Support queuing remediation for a user-selected set of files (not just full-course syncs). From Canvas, a user should be able to select specific files and hit a "queue for remediation" button.

**What's needed:**
- API endpoint: `POST /api/v1/remediate` accepting a list of `{ institutionId, courseId, canvasFileId }` entries.
- The endpoint should discover/upload only the listed files (skip full-course scan), create a batch, and publish the request.json.
- Consider: should this bypass the incremental filter (always re-process, even if the file hasn't changed)? Probably yes — the user explicitly asked for it.
- Canvas integration: the "queue for remediation" button would live in a Canvas LTI or plugin that calls this endpoint.
