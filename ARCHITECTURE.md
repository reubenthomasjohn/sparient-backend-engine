# AWS Deployment Architecture (dev)

Target region: **us-east-2**. Single environment for now.

---

## High-level picture

```
                                  ┌─────────────────────┐
                                  │   Canvas LMS (ext)  │
                                  └──────────┬──────────┘
                                             │  HTTPS (list, download, writeback)
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
                                   │    RDS PostgreSQL      │
                                   │    db.t4g.micro        │
                                   │    publicly accessible │
                                   │    20 GB gp3, single-AZ│
                                   └────────────────────────┘

                                  ┌───────────────────────────────┐
                                  │ S3 remediated bucket (exists) │
                                  │  written by Connectivo, read  │
                                  │  references stored on batch_  │
                                  │  files.remediated_s3_key      │
                                  └───────────────────────────────┘
```

All four arrows into RDS (api, discovery, upload, + local dev) go over the public Postgres endpoint, TLS-enforced, SG restricted to 0.0.0.0/0 on 5432 (dev only).

---

## Components

### Compute — all Lambda, all Docker

| Lambda | Trigger | Concurrency | Purpose |
|---|---|---|---|
| `api` | API Gateway (HTTP API) | default account limit | Express app wrapped by `@codegenie/serverless-express` |
| `discovery` | SQS (`discovery-queue`) | **MaxConcurrency = 5** | Handles `sweep` and `discover` messages |
| `upload` | SQS (`upload-queue`) | **MaxConcurrency = 10** | Streams one Canvas file to S3, runs BatchBuilder |

Concurrency caps are set on the SQS event source mapping so a large `force=true` can't overwhelm Canvas.

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
- **Access:** `publicly_accessible = true`, security group opens 5432 to `0.0.0.0/0`. TLS is enforced at the parameter-group level (`rds.force_ssl = 1`). Password auto-generated by Terraform and stored in SSM Parameter Store (SecureString, free tier).
- **Aurora swap path:** the DB lives in `modules/database`. Swap = replace `aws_db_instance` with `aws_rds_cluster` + `aws_rds_cluster_instance`. Outputs (`endpoint`, `password_param_name`) stay identical, so the Lambdas are unchanged.

### Storage

- Source + remediated S3 buckets **already exist**. Terraform does not create them — it only attaches IAM policies granting the Lambdas read/write access.
- Bucket names come from `.env` → Terraform variables.

### Secrets

- DB password: SSM Parameter Store SecureString (`/sparient/dev/db/password`).
- Canvas token, Connectivo key secret, Canvas domain, account id: SSM Parameter Store (SecureString / String).
- Lambdas reference params by name via env vars (`DB_PASSWORD_PARAM`, etc.) and fetch at cold-start.

### Networking

- **No VPC, no NAT Gateway, no ALB.** Lambdas run outside a VPC and reach RDS over its public endpoint + reach Canvas and S3 over the public internet.
- API Gateway is public; no custom domain, no ACM cert. Endpoint is the default `https://<api-id>.execute-api.us-east-2.amazonaws.com`.

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
│   ├── main.tf
│   └── README.md
├── envs/
│   └── dev/
│       ├── main.tf             # composes the modules below
│       ├── variables.tf
│       ├── backend.tf          # s3 + dynamodb state
│       └── terraform.tfvars    # you fill this in
└── modules/
    ├── database/               # RDS, param group, SSM password
    ├── queues/                 # 2 SQS queues + 2 DLQs + access policies
    ├── ecr/                    # 3 ECR repos with lifecycle (keep last 5)
    ├── lambda-api/             # api Lambda + API Gateway HTTP API
    ├── lambda-worker/          # generic module (reused for discovery + upload)
    ├── schedule/               # single EventBridge rule → SQS
    └── iam/                    # shared roles/policies (S3 read/write, SSM read)
```

Image build is a `Makefile` outside Terraform:

```
make build-api         # docker build + push :latest to ECR
make build-discovery
make build-upload
make deploy            # terraform apply
```

Lambdas reference `:latest` for dev simplicity. (Prod would use image digests.)

---

## Estimated monthly cost (dev, us-east-2)

| Item | Cost |
|---|---|
| RDS `db.t4g.micro` single-AZ + 20 GB gp3 | ~$13 |
| SQS (4 queues, very low traffic) | ~$0 (1M free) |
| Lambda (low traffic) | ~$0 (1M free) |
| API Gateway HTTP API | ~$0 (1M free) |
| EventBridge (1 rule, daily) | $0 |
| ECR storage (3 repos × ~200 MB × $0.10) | ~$0.06 |
| CloudWatch Logs (low volume) | ~$0–1 |
| SSM Parameter Store (Standard params) | $0 |
| Data transfer (S3 in us-east-2 → Lambda in us-east-2) | $0 |
| **Total** | **~$14/mo** |

No NAT Gateway. No ALB. No RDS Proxy. No Secrets Manager. These are the four AWS line items that would each silently add $15–40/mo; we're skipping all of them for dev.

---

## What Terraform does *not* do

- Build/push Docker images (Makefile does that).
- Create the S3 buckets (they exist).
- Manage Canvas credentials (you put them in SSM manually, or via `aws ssm put-parameter` after first apply).
- Create the first institution row (`npm run db:seed` still does that, run against the RDS endpoint).

---

## Bring-up order (first-time deploy)

1. `cd terraform/bootstrap && terraform apply` → state bucket + lock table.
2. `make build-api build-discovery build-upload` → ECR repos need to exist first, so actually:
3. `cd terraform/envs/dev && terraform apply -target=module.ecr` → creates repos.
4. `make build-api build-discovery build-upload` → push `:latest` images.
5. `terraform apply` → the rest.
6. `aws ssm put-parameter` for Canvas token, etc.
7. `DATABASE_URL=<rds-endpoint> npm run db:migrate`
8. `DATABASE_URL=<rds-endpoint> npm run db:seed`
9. `curl https://<api-id>.execute-api.us-east-2.amazonaws.com/health`
