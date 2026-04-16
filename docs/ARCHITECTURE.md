# AWS Deployment Architecture (dev)

Target region: **us-east-2**. Single environment for now.

---

## High-level picture

```
                                  ┌─────────────────────┐
                                  │   Canvas LMS (ext)  │
                                  └──────────┬──────────┘
                                             │  HTTPS (list, download, writeback)
                                             │  via NAT Gateway
                                             │
┌──────────────────┐   HTTPS       ┌─────────┴──────────────────────────┐
│    Connectivo    │◀─────────────▶│       API Gateway (HTTP API)       │
│   (external)     │               │              │                     │
└──────────────────┘               │              ▼                     │
                                   │     ┌────────────────┐             │
                                   │     │   api Lambda   │             │
                                   │     │ (Express app,  │             │
                                   │     │  Docker image) │             │
                                   │     └───┬────────┬───┘             │
                                   └─────────┼────────┼─────────────────┘
                                             │        │
                                             │        │ enqueue DiscoveryJob
                                             │        │ (force / manual sync)
                                             │        ▼
                                             │   ┌───────────────────┐
                                             │   │ discovery-queue   │◀───── EventBridge rule
                                             │   │       (SQS)       │       (nightly 02:00)
                                             │   │   + DLQ           │       payload: {type:"sweep"}
                                             │   └────────┬──────────┘
                                             │            │
                                             │            ▼
                                             │   ┌───────────────────┐
                                             │   │ discovery Lambda  │
                                             │   │  (Docker image)   │
                                             │   │  MaxConcurrency=5 │
                                             │   │                   │
                                             │   │ sweep ─► fan out: │
                                             │   │  • due insts      │
                                             │   │  • retry-eligible │
                                             │   │                   │
                                             │   │ discover ─► list  │
                                             │   │   Canvas, detect  │
                                             │   │   changes, enq    │
                                             │   │   UploadJobs      │
                                             │   └────────┬──────────┘
                                             │            │ enqueue UploadJob
                                             │            ▼
                                             │   ┌───────────────────┐
                                             │   │   upload-queue    │
                                             │   │      (SQS)        │
                                             │   │     + DLQ         │
                                             │   └────────┬──────────┘
                                             │            │
                                             │            ▼
                                             │   ┌───────────────────┐
                                             │   │  upload Lambda    │
                                             │   │  (Docker image)   │
                                             │   │ MaxConcurrency=10 │
                                             │   │                   │
                                             │   │ • re-fetch URL    │
                                             │   │ • stream Canvas ► │
                                             │   │   S3 source bkt   │
                                             │   │ • monotonic UPD   │
                                             │   │ • BatchBuilder    │
                                             │   │   claim           │
                                             │   └────────┬──────────┘
                                             │            │ PutObject
                                             │            ▼
                                             │    ┌──────────────────┐
                                             │    │  S3 source bkt   │
                                             │    │  (already exists)│
                                             │    └──────────────────┘
                                             │
                                             ▼
                                   ┌────────────────────────┐
                                   │      RDS Proxy         │◀── Lambdas connect here, not
                                   │  (pooled connections)  │    directly to RDS. Absorbs
                                   └──────────┬─────────────┘    cold-start churn.
                                              │
                                              ▼
                                   ┌────────────────────────┐
                                   │    RDS PostgreSQL      │
                                   │    db.t4g.micro        │
                                   │  private subnets only  │
                                   │    20 GB gp3, single-AZ│
                                   └────────────────────────┘

                                  ┌───────────────────────────────┐
                                  │ S3 remediated bucket (exists) │
                                  │  written by Connectivo, read  │
                                  │  references stored on batch_  │
                                  │  files.remediated_s3_key      │
                                  └───────────────────────────────┘
```

All Lambdas run in the VPC's private subnets. They reach Canvas and SSM over a NAT Gateway, reach S3 over the public AWS endpoint (still via NAT, no VPC endpoint configured yet), and reach RDS through RDS Proxy. RDS itself only accepts traffic from the proxy's security group.

---

## Components

### Compute — all Lambda, all Docker, all arm64

| Lambda | Trigger | Concurrency | Memory | Purpose |
|---|---|---|---|---|
| `api` | API Gateway (HTTP API) | 1 provisioned (always warm) | 1024 MB | Express app wrapped by `@codegenie/serverless-express` |
| `discovery` | SQS (`discovery-queue`) | MaxConcurrency = 5 | 1024 MB | Handles `sweep` and `discover` messages |
| `upload` | SQS (`upload-queue`) | MaxConcurrency = 10 | 1024 MB | Streams one Canvas file to S3, runs BatchBuilder |

Concurrency caps are set on the SQS event source mapping so a large `force=true` can't overwhelm Canvas. Provisioned concurrency on the API Lambda keeps one instance warm so Connectivo polls land on an already-initialized Prisma client.

Images are built with a shared `Dockerfile.lambda` (multi-stage, esbuild-bundled, only the `rhel-openssl-3.0.x` + `linux-arm64-openssl-3.0.x` Prisma engine binaries included). Target image size: ~150–200 MB, cold start ~500–800 ms for workers and ~300 ms for warm API invocations.

### Queues

| Queue | Consumer | Visibility timeout | Max receives | DLQ |
|---|---|---|---|---|
| `discovery-queue` | discovery Lambda | 15 min | 3 | `discovery-dlq` |
| `upload-queue` | upload Lambda | 15 min | 3 | `upload-dlq` |

Messages that exhaust `maxReceiveCount` land in the DLQ. No automatic consumer — you inspect via AWS console. (Alerting can come later.)

### Scheduled trigger — one rule only

| Rule | Schedule | Target | Payload |
|---|---|---|---|
| `nightly-sweep` | `cron(0 2 * * ? *)` UTC | `discovery-queue` (SQS, direct) | `{ "type": "sweep" }` |

The `sweep` message handler does *both*:
1. Find institutions where `sync_enabled AND (last_synced_at IS NULL OR last_synced_at + interval '1 day' < now())` → enqueue per-institution `DiscoveryJob`s.
2. Find source_files where `last_outcome = 'failed' AND retry_count < max_retries`:
   - Missing `s3_source_key` → enqueue an `UploadJob`
   - Has `s3_source_key` → `UPDATE … SET batched_modified_at = NULL, last_outcome = NULL` so BatchBuilder re-claims them on the next pass.

No separate retry Lambda, no separate retry schedule, no `next_retry_at` timing. `jobs/` and `RetryService` get deleted.

### Database

- **Engine:** `aws_db_instance` — RDS PostgreSQL 16, `db.t4g.micro`, 20 GB gp3, single-AZ.
- **Access:** private subnets only. Lambdas reach it through **RDS Proxy** (connection pooling, TLS required). Password auto-generated by Terraform, stored in SSM Parameter Store (SecureString) and mirrored into Secrets Manager (RDS Proxy requirement — it can't read from SSM).
- **Aurora swap path:** the DB lives in `modules/database`. Swap = replace `aws_db_instance` with `aws_rds_cluster` + `aws_rds_cluster_instance`. Outputs (`proxy_endpoint`, `db_password_param`) stay identical, so the Lambdas are unchanged.

### Storage

- Source + remediated S3 buckets **already exist**. Terraform does not create them — it only attaches IAM policies granting the Lambdas read/write access.
- Bucket names come from `.env` → Terraform variables.

### Secrets

- DB password: SSM Parameter Store SecureString (`/sparient-dev/db/password`) + mirrored Secrets Manager secret for RDS Proxy.
- Canvas credentials live per-institution in `institution.credentials` (JSONB in Postgres), not in AWS secret stores.
- For dev, the full `DATABASE_URL` (including password) is baked into Lambda env vars by Terraform. Acceptable tradeoff for dev (tfstate is encrypted; Lambda env is IAM-gated). For prod, switch to fetching the password from SSM at cold-start and assembling the URL in-process.

### Networking

- **VPC** with 2 AZ (us-east-2a, us-east-2b), 2 public subnets, 2 private subnets.
- **Single NAT Gateway** in one public subnet — cheaper than one-per-AZ and fine for dev. Lambdas reach Canvas + S3 through it.
- All Lambdas run in the private subnets; RDS and RDS Proxy also live in private subnets.
- API Gateway is public (no VPC attachment needed); no custom domain, no ACM cert. Endpoint is the default `https://<api-id>.execute-api.us-east-2.amazonaws.com`.

### Observability

- CloudWatch Logs (default Lambda behaviour). 14-day retention via Terraform.
- No dashboards/alarms at this stage.

---

## Schema additions needed for this architecture

Add to `institutions`:

```prisma
syncEnabled       Boolean @default(true)  @map("sync_enabled")
syncIntervalHours Int     @default(24)    @map("sync_interval_hours")
```

(The sweep uses these to decide who is due.)

---

## Terraform layout

```
terraform/
├── bootstrap/                  # one-time: creates the state bucket + lock table
├── envs/
│   └── dev/                    # only environment for now
│       ├── main.tf             # composes the modules below + shared IAM role
│       ├── variables.tf
│       ├── outputs.tf
│       ├── backend.tf          # s3 + dynamodb state
│       └── terraform.tfvars    # you fill this in (image URIs, bucket names)
└── modules/
    ├── networking/             # VPC, 2 public + 2 private subnets, 1 NAT GW
    ├── database/               # RDS + RDS Proxy + SSM password + Secrets Manager mirror
    ├── queues/                 # 2 SQS queues + 2 DLQs
    ├── ecr/                    # 3 ECR repos with "keep last 5" lifecycle
    ├── lambda-api/             # api Lambda + API Gateway HTTP API + provisioned concurrency
    ├── lambda-worker/          # generic module (reused for discovery + upload)
    └── schedule/               # single EventBridge rule → discovery queue
```

The shared Lambda execution role and SG live in `envs/dev/main.tf` — both are one-off and don't need a module.

Image builds are handled by **GitHub Actions CI** (`.github/workflows/deploy-dev.yml` and `deploy-single.yml`). CI pushes images to ECR tagged with both `:latest` and the commit SHA.

Terraform references images by URI. The AWS profile used by Terraform is set via `var.aws_profile` (default `sparient`).

---

## Estimated monthly cost (dev, us-east-2)

| Item | Cost |
|---|---|
| NAT Gateway (1 AZ) | ~$32 |
| RDS `db.t4g.micro` single-AZ + 20 GB gp3 | ~$15 |
| RDS Proxy | ~$15 |
| API Lambda provisioned concurrency (1 × 1 GB) | ~$5 |
| Secrets Manager (1 secret for RDS Proxy) | ~$0.40 |
| SQS / Lambda invocations / API GW / EventBridge | free tier |
| ECR storage (3 repos × ~200 MB × $0.10) | ~$0.06 |
| CloudWatch Logs (low volume) | ~$1 |
| SSM Parameter Store (Standard params) | $0 |
| **Total** | **~$68/mo** |

The three big-ticket items (NAT, RDS Proxy, provisioned concurrency) are deliberate: NAT keeps RDS off the public internet, RDS Proxy absorbs Lambda's cold-start connection churn, provisioned concurrency keeps Connectivo polls warm.

---

## What Terraform does *not* do

- Build/push Docker images (GitHub Actions CI does that).
- Create the S3 buckets (they exist).
- Manage Canvas credentials (you put them in SSM manually, or via `aws ssm put-parameter` after first apply).
- Create the first institution row (`npm run db:seed` still does that, run against the RDS endpoint).

---

## Bring-up order (first-time deploy)

See `terraform/README.md` for the full walkthrough. Summary:

1. `cd terraform/bootstrap && terraform apply` → state bucket + lock table.
2. Fill in `envs/dev/backend.tf` with the bucket name.
3. `cd terraform/envs/dev && terraform apply -target=module.ecr` → creates ECR repos.
4. Push a bootstrap placeholder image (see `terraform/README.md`).
5. `terraform apply` → the rest (VPC, RDS, RDS Proxy, SQS, Lambdas, API GW, EventBridge).
6. Run Prisma migrations + seed against the RDS endpoint (from a temporary bastion / SSM session, since RDS is private).
7. `curl "$(terraform output -raw api_endpoint)/health"`
