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
                                       │ sends {type: "discover", institutionId}
                                       ▼
                              ┌───────────────────┐
             EventBridge ────▶│  discovery queue   │  SQS
           (every 15 min)     │      + DLQ         │
           {type: "tick"}     └────────┬───────────┘
                                       │
                                       ▼
                              ┌───────────────────┐
                              │ discovery Lambda   │
                              │  MaxConcurrency=5  │
                              │                    │
                              │ tick:              │
                              │  • check sync_time │
                              │    per institution  │
                              │  • enqueue due ones│
                              │                    │
                              │ discover:          │
                              │  • list Canvas     │
                              │    courses          │
                              │  • start one SFN   │
                              │    execution per    │
                              │    course           │
                              └────────┬───────────┘
                                       │ StartExecution (one per course)
                                       ▼
                    ┌──────────────────────────────────────┐
                    │   Step Functions: course-workflow     │
                    │                                      │
                    │  ┌──────────────┐                    │
                    │  │ discover-    │  list files,       │
                    │  │ files        │  FileChangeDetector│
                    │  └──────┬───────┘                    │
                    │         │ returns uploadJobs[]       │
                    │         ▼                            │
                    │  ┌──────────────┐                    │
                    │  │  Map state   │  parallel,         │
                    │  │  (max 10)    │  MaxConcurrency=10 │
                    │  │              │                    │
                    │  │ upload-file  │  re-fetch Canvas   │
                    │  │ upload-file  │  URL, stream to S3,│
                    │  │ upload-file  │  monotonic UPDATE  │
                    │  └──────┬───────┘                    │
                    │         │ waits for ALL to finish    │
                    │         ▼                            │
                    │  ┌──────────────┐                    │
                    │  │ batch-       │  BatchBuilder +    │
                    │  │ publish      │  RequestPublisher  │
                    │  │              │  → one request.json│
                    │  └──────────────┘    per course      │
                    └──────────────────────────────────────┘
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
| `sparient-dev-discovery` | discovery queue (SQS) | 5 | `tick`: check which institutions are due (by `sync_time`). `discover`: list courses, start one SFN execution per course |
| `sparient-dev-course-workflow` | Step Functions | 10 (via Map state) | All 3 SFN steps: discover-files, upload-file, batch-publish |
| `sparient-dev-responses` | responses queue (SQS) | 5 | Read + validate response.json from S3, write outcomes to DB |

All Lambdas: 1024 MB memory, 15-min timeout (workers), 30s timeout (API). No VPC attachment.

### Step Functions (1 state machine)

`sparient-dev-course-workflow` — per-course orchestration:

| Step | Type | What it does |
|---|---|---|
| `DiscoverFiles` | Task | Lists files from Canvas, runs FileChangeDetector, returns upload list |
| `UploadFiles` | Map (max 10) | Parallel upload — each invocation streams one file from Canvas → S3. Step Functions waits for ALL to finish. Built-in retry (2 attempts, 30s backoff). |
| `BatchAndPublish` | Task | Creates one batch with all uploaded files, writes one request.json to S3. Also retries failed files + releases stuck batches for this course. |

Step Functions guarantees one batch per course per sync pass — no split batches from parallel uploads.

### SQS Queues (2 + 2 DLQs)

| Queue | Producer | Consumer | Notes |
|---|---|---|---|
| `sparient-dev-discovery` | API Lambda (manual sync), EventBridge (tick every 15 min) | discovery Lambda | `tick` and `discover` message types |
| `sparient-dev-responses` | S3 event notification (response bucket) | responses Lambda | Triggered when Connectivo writes response.json |

Visibility timeout: 15 min. Max receives: 3 before DLQ.

### S3 Buckets (4 total)

| Bucket | Owner | Purpose |
|---|---|---|
| `connectivo-incoming` | We write | Source files streamed from Canvas (content-addressed keys) |
| `connectivo-remediated` | Connectivo writes | Remediated PDFs |
| `sparient-remediation-requests` | We write | Per-batch request.json that Connectivo polls |
| `sparient-remediation-responses` | Connectivo writes | Per-batch response.json → triggers S3 event → SQS → responses Lambda |

### Scheduled trigger

| Rule | Schedule | Target | Payload |
|---|---|---|---|
| `sparient-dev-tick` | `rate(15 minutes)` | discovery queue (SQS) | `{ "type": "tick" }` |

The tick handler checks each institution's `sync_time` ("HH:MM" UTC) against the current time. An institution is due if:
- `sync_enabled = true`
- Current time is within the 15-min window of `sync_time`
- `last_synced_at` is null or before today

Scheduling is fully DB-driven — change an institution's `sync_time` in the database, no infra changes needed.

### Discovery fan-out

Two levels of fan-out to avoid overloading a single Lambda:

```
EventBridge tick (every 15 min)
        │
        ▼
{type: "tick"}                    ── tick handler:
        │                            check sync_time per institution
        │                            enqueue {discover} for due ones
        ▼
{type: "discover", institutionId} ── institution discover:
        │                            list courses from Canvas, upsert to DB,
        │                            start one SFN execution per active course
        ▼
Step Functions (one per course)   ── course workflow:
        │                            discover-files → Map(upload, max 10) → batch-publish
        │                            Step Functions guarantees "wait for all" —
        │                            one batch per course, no split batches
        ▼
request.json written to S3       ── Connectivo polls and processes
```

- Each course gets its own SFN execution → parallel processing, isolation.
- A heavy course can't block others.
- If one upload fails, SFN retries it (2 attempts, 30s backoff). If all retries fail, the batch step still runs with whatever succeeded.
- Manual single-course sync (`POST /sync/.../courses/:courseId`) starts an SFN execution directly (skips the institution fan-out).

### Database

**Neon Postgres** (free tier). Publicly reachable, TLS enforced. Terraform creates the Neon project via the `kislerdm/neon` provider; connection URI is passed to Lambdas as `DATABASE_URL`.

For prod: switch to RDS + RDS Proxy in a VPC (modules already written). See `docs/TODO.md`.

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
| Step Functions (~$0.025/1000 executions) | ~$0 |
| SQS / Lambda / API GW / EventBridge | free tier |
| ECR storage (4 repos) | ~$0.10 |
| CloudWatch Logs | ~$1 |
| **Total** | **~$1/mo** |

---

## First-time deploy

1. `cd terraform/bootstrap && terraform apply` → state bucket + OIDC provider.
2. Fill in `envs/dev/backend.tf` with the state bucket name.
3. `cd terraform/envs/dev && terraform apply -target=module.ecr` → creates ECR repos.
4. Push bootstrap placeholder images to all 4 repos.
5. `terraform apply` → the rest (Neon, SQS, Lambdas, SFN, API GW, EventBridge).
6. Set GitHub Actions variables/secrets.
7. `npm run db:migrate && npm run db:seed` against the Neon connection URI.
8. Push to `main` → CI deploys real images.
