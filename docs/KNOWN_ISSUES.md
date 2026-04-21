# Known Issues

Remaining bugs and improvements from the audit (2026-04-21). Critical bugs have been fixed. Items below are medium/low severity — address before scaling to production.

---

## Medium

### M1. BatchBuilder rollback doesn't restore `lastOutcome` or increment `retryCount`
- **File:** `src/services/sync/BatchBuilder.ts` (rollback path)
- **Issue:** On publish failure, `lastOutcome` was cleared during the claim but the rollback now properly calls `computeFailureUpdate` to record the failure. **FIXED in this session.**

### M2. `Institution.lastSyncedAt` updated before SFN confirms success
- **File:** `src/workers/discovery/handler.ts:77-79`
- **Issue:** If the SFN execution fails, `lastSyncedAt` is already stamped. The tick guard prevents retry until tomorrow.
- **Fix:** Use SFN execution name `${institutionId}-${dateString}` for idempotency. Move `lastSyncedAt` update to after SFN success (via CloudWatch Events rule), or use a separate `lastSyncStartedAt` field.

### M3. Local dev fallback calls `batchPublish` before uploads run
- **File:** `src/services/sync/SyncOrchestrator.ts:26-46`
- **Issue:** `discoverFiles` returns fileIds but no uploads execute before `batchPublish`. Files are silently skipped.
- **Fix:** Run `uploadFile` inline for each fileId before calling `batchPublish` in the local dev path.

### M4. PrismaPg creates default pool (size 10) per Lambda cold start
- **File:** `src/db/client.ts`
- **Issue:** At scale, many concurrent Lambdas × 10 connections each will exhaust Neon's connection limit.
- **Fix:** Set `pool: { max: 1 }` in PrismaPg constructor. Lambda is single-threaded.

### M5. `FileChangeDetector` mass-delete guard only catches empty list
- **File:** `src/services/sync/FileChangeDetector.ts:83`
- **Issue:** If Canvas returns a truncated list (pagination bug), excess files are marked deleted. Rediscovered files at the same `modifiedAt` stay stuck as `deleted` (`isNewer` is false).
- **Fix:** Add proportional guard (`toDelete.length / existing.length > 0.5` → skip). Clear `lastOutcome: 'deleted'` when a file reappears regardless of `isNewer`.

### M6. `UploadFailed` Pass state in SFN loses `sourceFileId` context
- **File:** `terraform/envs/dev/main.tf` (SFN definition, UploadFailed state)
- **Issue:** Returns `{ success: false }` without `sourceFileId`. Downstream gets inconsistent shapes.
- **Fix:** Use `Parameters = { "sourceFileId.$": "$.sourceFileId", "success": false }`.

### M7. `FileIssueCategory` missing index on `batchFileId`
- **File:** `prisma/schema.prisma`
- **Issue:** No `@@index([batchFileId])` — lookups by batch_file will be full table scans at scale.
- **Fix:** Add `@@index([batchFileId])` to `FileIssueCategory`.

### M8. CI `deploy` job doesn't wait for `migrate`
- **File:** `.github/workflows/deploy-dev.yml:166`
- **Issue:** `deploy` needs `[terraform, build]` but not `migrate`. Lambdas can be updated before schema changes.
- **Fix:** Add `migrate` to `deploy.needs`.

### M9. SQS visibility timeout equals Lambda timeout (no buffer)
- **File:** `terraform/modules/queues/main.tf`
- **Issue:** Both are 900s. If Lambda times out, the message is immediately redelivered while Lambda may still be cleaning up.
- **Fix:** Set visibility timeout to 960s (Lambda timeout + 60s buffer).

### M10. `dlq_arn` for discovery_worker passes main queue ARN, not DLQ ARN
- **File:** `terraform/envs/dev/main.tf:193`
- **Issue:** `dlq_arn = module.queues.discovery_queue_arn` — this is the main queue. The queues module has no DLQ ARN output.
- **Fix:** Add `output "discovery_dlq_arn"` to queues module and reference it.

### M11. GitHub Actions role has `AdministratorAccess`
- **File:** `terraform/envs/dev/main.tf:497`
- **Issue:** Overly broad. A compromised workflow has unrestricted AWS access.
- **Fix:** Scope to specific actions needed (ECR push, Lambda update, SFN describe, S3 state, Terraform resources). Already in TODO.

---

## Low

### L1. Missing `--platform linux/amd64` in CI Docker build
- **File:** `.github/workflows/deploy-dev.yml:150`
- **Fix:** Add `--platform linux/amd64` to `docker build` for explicit architecture.

### L2. `backend.tf` requires `>= 1.6` but `use_lockfile` needs `>= 1.10`
- **File:** `terraform/envs/dev/backend.tf`
- **Fix:** Change `required_version = ">= 1.10"`.

### L3. Tick 15-min window has no jitter tolerance
- **File:** `src/workers/discovery/handler.ts:36-38`
- **Fix:** Widen window to 20 minutes (`diff >= 20`).

### L4. `requestS3Bucket`/`requestS3Key` nullable pair lacks DB constraint
- **File:** `prisma/schema.prisma`
- **Fix:** Add `CHECK` constraint ensuring both are null or both are non-null.

### L5. Stale request.json remains in S3 after publish-failure rollback
- **File:** `src/services/sync/BatchBuilder.ts`
- **Issue:** If `putJson` succeeds but the `batch.update` recording `requestWrittenAt` fails, Connectivo may process a stale request for a failed batch. RemediationService no-ops it (idempotent), but Connectivo wastes compute.
- **Fix:** Attempt S3 delete of the request key in the rollback path.

### L6. No partial index for BatchBuilder eligibility query at scale
- **File:** `prisma/schema.prisma`
- **Fix:** Add partial index: `CREATE INDEX ... ON source_files (course_id, s3_source_modified_at) WHERE s3_source_key IS NOT NULL AND last_outcome NOT IN ('deleted', 'permanently_failed')`.

### L7. OIDC condition uses `StringLike` without wildcard
- **File:** `terraform/envs/dev/main.tf:487`
- **Fix:** Change to `StringEquals` for clarity.
