# TODO

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

## On-demand file remediation

Support queuing remediation for a user-selected set of files (not just full-course syncs). From Canvas, a user should be able to select specific files and hit a "queue for remediation" button.

**What's needed:**
- API endpoint: `POST /api/v1/remediate` accepting a list of `{ institutionId, courseId, canvasFileId }` entries.
- The endpoint should discover/upload only the listed files (skip full-course scan), create a batch, and publish the request.json.
- Consider: should this bypass the incremental filter (always re-process, even if the file hasn't changed)? Probably yes — the user explicitly asked for it.
- Canvas integration: the "queue for remediation" button would live in a Canvas LTI or plugin that calls this endpoint.
