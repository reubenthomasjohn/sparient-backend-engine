# TODO

## Review remediated_path stripping logic

`RemediationService` strips `/<bucket>/` from Connectivo's `remediated_path` to get the actual S3 key. This assumes Connectivo always prefixes the path with `/<bucket-name>/`. If their format changes, the stripping regex (`/^\/[^/]+\//`) will break. Consider deriving the remediated key from the source key instead (`${S3_PREFIX.REMEDIATED}/${batchFile.s3SourceKey}`), which doesn't depend on Connectivo's path format at all.

## Clean up hardcoded S3 bucket in seed script

`prisma/seed.ts` hardcodes `accesshub-remediation-storage` as the institution's S3 bucket and manually configures the S3 event notification. This was a quick-start shortcut. Once the institution registration endpoint exists, remove the hardcoded bucket from the seed and use `provisionInstitutionBucket` (which creates the bucket + configures notifications dynamically).

## Institution registration API endpoint

Add `POST /api/v1/institutions` — creates an institution record + provisions its S3 bucket. Currently institutions are only created via `npm run db:seed`.

**What's needed:**
- Accept: `{ name, slug, sourceType, credentials: { domain, account_id, api_token }, syncTime?, writebackOptIn? }`
- Validate: slug uniqueness, credential format
- Create the institution row in DB
- Call `provisionInstitutionBucket(institutionId)` to create + configure the S3 bucket
- Return the institution record + bucket name
- Error rollback: if bucket creation fails after DB insert, delete the institution row (or mark it as `provisioning_failed`)

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

`CanvasFileReplacer` today reads the full S3 object into memory via `s3Service.getSourceFileBytes` before POSTing to Canvas. Fine for the current MIME filter (PDFs/docx/pptx/xlsx, typically <20MB, one file per Lambda invocation), but worth switching when file sizes grow or we broaden the filter.

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

**Why not now:** MIME filter keeps files small, each Lambda handles one file in isolation (so concurrency doesn't compound), and the per-file savings are a few hundred ms. Pick this up if (a) the MIME filter widens, (b) we see OOMs, or (c) total upload latency becomes a user-visible issue.

## On-demand file remediation

Support queuing remediation for a user-selected set of files (not just full-course syncs). From Canvas, a user should be able to select specific files and hit a "queue for remediation" button.

**What's needed:**
- API endpoint: `POST /api/v1/remediate` accepting a list of `{ institutionId, courseId, canvasFileId }` entries.
- The endpoint should discover/upload only the listed files (skip full-course scan), create a batch, and publish the request.json.
- Consider: should this bypass the incremental filter (always re-process, even if the file hasn't changed)? Probably yes — the user explicitly asked for it.
- Canvas integration: the "queue for remediation" button would live in a Canvas LTI or plugin that calls this endpoint.
