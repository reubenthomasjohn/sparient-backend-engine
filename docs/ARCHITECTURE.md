# AWS Deployment Architecture (dev)

Target region: **us-east-2**. Single environment, Neon Postgres, no VPC.

---

## System flow

```
                              You / Postman / Canvas LTI
                                        │
                                        ▼
                              ┌───────────────────┐
                              │   API Lambda       │  Express app
                              │  (API Gateway)     │  POST /sync, GET /batches, etc.
                              └────────┬───────────┘
                                       │
                         POST /sync/institutions/:id
                                       │ sends {type: "discover", institutionId, courseId?}
                                       ▼
                              ┌───────────────────┐
             EventBridge ────▶│  discovery queue   │  SQS
          (daily 02:00 UTC)   │      + DLQ         │
          {type: "sweep"}     └────────┬───────────┘
                                       │
                                       ▼
                              ┌───────────────────┐
                              │ discovery Lambda   │
                              │  MaxConcurrency=5  │
                              │                    │
                              │ sweep:             │
                              │  • find due insts  │    1 discover msg per institution
                              │  • retry failed    │
                              │                    │
                              │ discover:          │
                              │  • list Canvas     │
                              │    courses + files  │
                              │  • FileChange      │
                              │    Detector         │
                              │  • enqueue 1       │
                              │    UploadJob per    │
                              │    changed file     │
                              │  • BatchBuilder     │    for files already in S3
                              │    + RequestPublisher│   writes request.json
                              └───┬────────────┬────┘
                                  │            │
                  1 msg per file  │            │  request.json written after
                                  ▼            │  batch is created
                         ┌──────────────┐      │
                         │ upload queue  │      │
                         │    (SQS)      │      │
                         │   + DLQ       │      │
                         └──────┬───────┘      │
                                │              │
                                ▼              │
                       ┌──────────────────┐    │
                       │  upload Lambda   │    │
                       │ MaxConcurrency=10│    │
                       │                  │    │
                       │ • re-fetch Canvas│    │
                       │   URL (fresh)    │    │
                       │ • stream to S3   │    │
                       │   source bucket  │    │
                       │ • monotonic      │    │
                       │   UPDATE guard   │    │
                       │ • BatchBuilder   │    │    also writes request.json
                       │   + RequestPub   │────┘    for newly uploaded files
                       └──────────────────┘
                                │
                                ▼
                       ┌──────────────────┐     ┌──────────────────────────────┐
                       │  S3 source bkt   │     │ S3: sparient-remediation-     │
                       │ (connectivo-     │     │     requests/                 │
                       │  incoming)       │     │   <instId>/<courseId>/        │
                       └──────────────────┘     │   <batchId>.json             │
                                                └──────────────┬───────────────┘
                                                               │
                                          Connectivo polls this bucket,
                                          downloads source files from source bkt,
                                          remediates, uploads PDFs to remediated bkt,
                                          writes response.json ─────────────────────┐
                                                                                    │
                       ┌──────────────────┐                                         ▼
                       │ S3 remediated bkt│     ┌──────────────────────────────┐
                       │ (connectivo-     │     │ S3: sparient-remediation-     │
                       │  remediated)     │     │     responses/                │
                       └──────────────────┘     │   <instId>/<courseId>/        │
                                                │   <batchId>.json             │
                                                └──────────────┬───────────────┘
                                                               │ S3 event notification
                                                               ▼
                                                      ┌───────────────────┐
                                                      │ responses queue   │  SQS
                                                      │    + DLQ          │
                                                      └────────┬──────────┘
                                                               │
                                                               ▼
                                                      ┌───────────────────┐
                                                      │ responses Lambda  │
                                                      │                   │
                                                      │ • Zod-validate    │
                                                      │   response.json   │
                                                      │ • RemediationSvc  │
                                                      │   writes outcomes │
                                                      │   to Neon DB      │
                                                      │ • batch → terminal│
                                                      └───────────────────┘

                                                All Lambdas ──▶ Neon Postgres
                                                               (public endpoint,
                                                                TLS enforced)
```

---

## Components

### Lambdas (4 total, all Docker x86_64)

| Lambda | Trigger | MaxConcurrency | Purpose |
|---|---|---|---|
| `sparient-dev-api` | API Gateway (HTTP API) | account default | Express app: sync triggers, batch queries, admin endpoints |
| `sparient-dev-discovery` | discovery queue (SQS) | 5 | `sweep`: find due institutions + retries. `discover` (institution): list courses, fan out per course. `discover` (course): list files, detect changes, enqueue uploads, batch + publish |
| `sparient-dev-upload` | upload queue (SQS) | 10 | Stream one Canvas file → S3 source bucket, then BatchBuilder + RequestPublisher |
| `sparient-dev-responses` | responses queue (SQS) | 5 | Read response.json from S3, validate, write outcomes to DB |

All Lambdas: 1024 MB memory, 15-min timeout (workers), 30s timeout (API). No VPC attachment — Neon is publicly reachable.

### SQS Queues (3 + 3 DLQs)

| Queue | Producer | Consumer | Notes |
|---|---|---|---|
| `sparient-dev-discovery` | API Lambda (manual sync), EventBridge (daily sweep) | discovery Lambda | Two message shapes: `sweep` and `discover` |
| `sparient-dev-upload` | discovery Lambda | upload Lambda | One message per changed file |
| `sparient-dev-responses` | S3 event notification (response bucket) | responses Lambda | Triggered when Connectivo writes response.json |

Visibility timeout: 15 min. Max receives: 3 before DLQ. Messages in DLQs are inspected manually.

### S3 Buckets (4 total)

| Bucket | Owner | Purpose |
|---|---|---|
| `connectivo-incoming` | We write | Source files streamed from Canvas (content-addressed keys) |
| `connectivo-remediated` | Connectivo writes | Remediated PDFs |
| `sparient-remediation-requests` | We write | Per-batch request.json that Connectivo polls |
| `sparient-remediation-responses` | Connectivo writes | Per-batch response.json → triggers S3 event → SQS → responses Lambda |

Source + remediated buckets existed before Terraform. Request + response buckets are Terraform-managed.

### Discovery fan-out

Discovery uses two levels of fan-out to avoid overloading a single Lambda:

```
EventBridge / API trigger
        │
        ▼
{type: "discover", institutionId}          ── institution-level discover:
        │                                      list courses from Canvas, upsert to DB,
        │                                      fan out one message per active course
        ▼
{type: "discover", institutionId, "101"}   ── course-level discover (own Lambda):
{type: "discover", institutionId, "102"}      list files, FileChangeDetector,
{type: "discover", institutionId, "103"}      enqueue UploadJobs, BatchBuilder
...                                           + RequestPublisher
        │
        ▼ (one msg per changed file)
{sourceFileId, modifiedAtMs}               ── upload Lambda (own Lambda):
                                              stream Canvas → S3, BatchBuilder
```

- Each course gets its **own Lambda invocation** → parallel processing up to MaxConcurrency=5.
- A heavy course can't block others — it runs in isolation.
- If one course fails, only that SQS message retries (3 attempts → DLQ). Other courses are unaffected.
- `force` flag flows through the fan-out so each course-level discover respects it.
- Manual single-course sync (`POST /sync/.../courses/:courseId`) skips the institution fan-out and goes straight to the course-level discover.
- For a heavy course with thousands of files: the expensive part (downloading from Canvas) is already fanned out to the upload queue (one message per file, MaxConcurrency=10). Discovery itself just lists files from Canvas (~1s per 100 files, paginated) and runs FileChangeDetector (DB queries). Even 10,000 files finishes in under a minute.

### Scheduled trigger

| Rule | Schedule | Target | Payload |
|---|---|---|---|
| `sparient-dev-nightly-sweep` | `cron(0 2 * * ? *)` UTC | discovery queue (SQS, direct) | `{ "type": "sweep" }` |

The sweep handler:
1. Finds institutions where `sync_enabled = true` and `last_synced_at + sync_interval_hours < now()` → enqueues one `{type: 'discover'}` per due institution.
2. Finds retry-eligible failed files (`last_outcome = 'failed', retry_count < max_retries`) → re-enqueues uploads or clears `batched_modified_at` for re-batching.
3. Releases stuck unpublished batches (`status = 'pending', request_written_at IS NULL`) → clears claims, marks batch failed.

### Database

**Neon Postgres** (free tier). Publicly reachable, TLS enforced. No VPC, no NAT, no RDS Proxy needed. Terraform creates the Neon project via the `kislerdm/neon` provider; connection URI is passed to Lambdas as the `DATABASE_URL` env var.

For prod: switch to RDS + RDS Proxy in a VPC. Terraform modules (`modules/networking`, `modules/database`) are already written. See `docs/TODO.md`.

### CI/CD

Push to `main` → GitHub Actions workflow (`deploy-dev.yml`):
1. **Terraform apply** — creates/updates all infra (OIDC auth, no stored keys)
2. **Prisma migrate deploy** — applies pending migrations against Neon
3. **Build 4 Docker images** — parallel matrix, one per Lambda
4. **Update 4 Lambdas** — `aws lambda update-function-code` with the commit SHA tag

GitHub repo settings:

| Type | Name | Purpose |
|---|---|---|
| Variable | `AWS_ACCOUNT_ID` | ECR URI construction |
| Variable | `AWS_ROLE_ARN_DEV` | OIDC role for CI |
| Secret | `NEON_API_KEY` | Terraform Neon provider auth |

---

## Cost (dev, us-east-2)

| Item | Cost |
|---|---|
| Neon Postgres (free tier) | $0 |
| SQS / Lambda / API GW / EventBridge | free tier |
| ECR storage (4 repos) | ~$0.10 |
| CloudWatch Logs | ~$1 |
| **Total** | **~$1/mo** |

---

## First-time deploy

1. `cd terraform/bootstrap && terraform apply` → state bucket + OIDC provider.
2. Fill in `envs/dev/backend.tf` with the state bucket name.
3. `cd terraform/envs/dev && terraform apply -target=module.ecr` → creates ECR repos.
4. Push bootstrap placeholder images to all 4 repos (see `terraform/README.md`).
5. `terraform apply` → the rest.
6. Set GitHub Actions variables/secrets.
7. `npm run db:migrate && npm run db:seed` against the Neon connection URI.
8. Push to `main` → CI deploys real images.
