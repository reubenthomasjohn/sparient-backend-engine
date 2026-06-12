# Terraform

Deploys the engine to AWS: Neon Postgres, SQS, ECR, 5 Lambdas (api, discovery, course-workflow, responses, writeback),
Step Functions, API Gateway HTTP API, and an EventBridge tick (every 15 min).

## Layout

```
terraform/
├── bootstrap/        # run once per account: S3 state bucket + DynamoDB lock table + OIDC provider
├── envs/dev/         # the dev environment (Neon, no VPC) — account 882884689403, us-east-2
├── envs/prod/        # the prod environment (RDS + RDS Proxy, VPC) — same account, us-west-2
└── modules/
    ├── networking/   # VPC + single NAT + public/private subnets (used by prod)
    ├── database/     # RDS + RDS Proxy connection pooling (used by prod)
    ├── queues/       # discovery + writeback SQS queues + DLQs
    ├── ecr/          # 5 ECR repos with lifecycle "keep last 5"
    ├── lambda-api/   # api Lambda + API Gateway HTTP API
    ├── lambda-worker/# generic SQS-triggered worker Lambda (discovery, responses, writeback)
    └── schedule/     # EventBridge rule → SQS (tick every 15 min)
```

## First-time deploy

```bash
# 1. Bootstrap (once per AWS account).
cd terraform/bootstrap
terraform init
terraform apply -var='state_bucket_name=sparient-tfstate-<suffix>'

# 2. Fill in envs/dev/backend.tf with the bucket name from step 1.

# 3. Fill in terraform.tfvars.
cd ../envs/dev
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars

# 4. Create ECR repos.
export TF_VAR_neon_api_key=napi_...
terraform init -backend-config="profile=sparient"
terraform apply -target=module.ecr

# 5. Push bootstrap placeholder images.
ECR_BASE=882884689403.dkr.ecr.us-east-2.amazonaws.com
aws ecr get-login-password --region us-east-2 --profile sparient | \
  docker login --username AWS --password-stdin $ECR_BASE
docker pull public.ecr.aws/lambda/nodejs:20
for repo in sparient-api sparient-discovery sparient-course-workflow sparient-responses sparient-writeback; do
  docker tag public.ecr.aws/lambda/nodejs:20 $ECR_BASE/$repo:bootstrap
  docker push $ECR_BASE/$repo:bootstrap
done

# 6. Full apply.
terraform apply

# 7. Set GitHub Actions variables/secrets.
#    Variables:
#      AWS_ACCOUNT_ID   = 882884689403
#      AWS_ROLE_ARN_DEV = $(terraform output -raw github_actions_role_arn)
#    Secrets:
#      NEON_API_KEY     = napi_...

# 8. Run migrations + seed.
export DATABASE_URL="$(terraform output -raw neon_connection_uri)"
npm run db:migrate
npm run db:seed

# 9. Push to main — CI builds real images and deploys.

# 10. Test.
curl "$(terraform output -raw api_endpoint)/health"
```

## Production (`envs/prod` — same account, us-west-2)

Prod runs on **RDS Postgres + RDS Proxy** (connection pooling) with all Lambdas inside a
**VPC** (private subnets, single NAT). It lives in the **same AWS account** as dev (`882884689403`),
in **us-west-2**, under a separate Terraform state key. No second bootstrap is needed — the
state bucket, lock table, and GitHub OIDC provider already exist from the dev bootstrap. The
existing `sparient` profile deploys both envs.

> **Heads-up (shared account):** per-institution `sparient-<id>` buckets are created at runtime
> with globally-unique names, so dev and prod will **share a bucket** for any institution ID
> present in both. Keep prod institution IDs distinct from dev's to avoid commingling data.

```bash
cd terraform/envs/prod
cp terraform.tfvars.example terraform.tfvars   # edit if needed

# 1. Init against the shared state bucket (separate key: prod/terraform.tfstate).
terraform init -backend-config="profile=sparient"

# 2. Create ECR repos first (app repos via the module, migrate repo standalone).
terraform apply -target=module.ecr -target=aws_ecr_repository.migrate

# 3. Push bootstrap placeholder images to all 6 repos (us-west-2).
ECR_BASE=882884689403.dkr.ecr.us-west-2.amazonaws.com
aws ecr get-login-password --region us-west-2 --profile sparient | \
  docker login --username AWS --password-stdin $ECR_BASE
docker pull public.ecr.aws/lambda/nodejs:20
for repo in sparient-api sparient-discovery sparient-course-workflow \
            sparient-responses sparient-writeback sparient-migrate; do
  docker tag public.ecr.aws/lambda/nodejs:20 $ECR_BASE/$repo:bootstrap
  docker push $ECR_BASE/$repo:bootstrap
done

# 4. Full apply (creates VPC, RDS, RDS Proxy, Lambdas, migrate Lambda, API GW, …).
terraform apply

# 5. Set GitHub Actions variable (repo → Settings → Secrets and variables → Actions):
#      AWS_ROLE_ARN_PROD = $(terraform output -raw github_actions_role_arn)
#    AWS_ACCOUNT_ID is already set from dev (same account). No NEON_API_KEY — prod has no Neon.

# 6. First migration runs automatically: push the `prod` branch (or run the
#    "Deploy (prod)" workflow manually). The migrate job builds the migrate image,
#    points the migrate Lambda at it, and invokes it inside the VPC.
#    To run migrations by hand instead:
#      aws lambda invoke --function-name sparient-prod-migrate --region us-west-2 \
#        --cli-read-timeout 300 /tmp/out.json --profile sparient && cat /tmp/out.json

# 7. Seed the first institution (run from inside the VPC, e.g. via the migrate Lambda
#    pattern or an SSM session — the RDS Proxy is private and not reachable locally).

# 8. Test.
curl "$(terraform output -raw api_endpoint)/health"
```

**Why the migrate Lambda?** RDS is `publicly_accessible = false` and the RDS Proxy lives in
private subnets, so a GitHub-hosted runner can't reach it. `sparient-prod-migrate` runs
`prisma migrate deploy` from *inside* the VPC; CI invokes it and asserts `{ok:true}`.

**TLS:** the RDS Proxy presents the Amazon RDS CA, which isn't in Node's default trust list.
The images bundle `certs/rds-global-bundle.pem` and prod Lambdas set
`NODE_EXTRA_CA_CERTS` to it, so `sslmode=verify-full` works unchanged.

### Updating prod

Push to the **`prod`** branch (or run the **"Deploy (prod)"** workflow manually). CI:
tests → terraform apply → build 6 images → invoke migrate Lambda → update 5 app Lambdas.

### Tearing down (dev and prod are independent)

Dev and prod have **separate Terraform states** (`dev/terraform.tfstate` vs
`prod/terraform.tfstate`) and **separately-named resources** (`sparient-dev-*` vs
`sparient-prod-*`, distinct VPCs / RDS / Lambdas / IAM roles). So:

```bash
cd terraform/envs/prod && terraform destroy   # tears down ONLY prod; dev untouched
cd terraform/envs/dev  && terraform destroy   # tears down ONLY dev;  prod untouched
```

`terraform destroy` only touches resources in its own state — the two never overlap.

`terraform destroy` only touches resources in its own state — the two never overlap. The
shared `accesshub-videos` bucket lives in **`bootstrap`** (not in either env), so destroying
either env leaves it untouched.

Manual cleanup for AWS resources Terraform can't auto-delete:
- **S3 buckets must be emptied first.** The per-institution `sparient-<id>` buckets are created
  at runtime and are in *neither* state — list and remove them by hand.
- ECR repos hold images, but the module sets `force_delete = true`, so destroy handles them.
- Prod RDS has `deletion_protection = true` and takes a **final snapshot** — disable protection
  (`-var`/console) before destroy if you really mean to drop the DB.
- Don't destroy `bootstrap` (the shared state bucket + lock table + OIDC + videos bucket) until
  *both* envs are gone.

### One-time: move `accesshub-videos` into bootstrap state

The bucket already exists in dev's state. Re-home it **without recreating it** (so the video
objects are preserved) by forgetting it from dev and importing it into bootstrap:

```bash
# 1. Forget it from dev's state (does NOT delete the real bucket).
cd terraform/envs/dev
for r in \
  aws_s3_bucket.accesshub_videos \
  aws_s3_bucket_public_access_block.accesshub_videos \
  aws_s3_bucket_policy.accesshub_videos_public_read \
  aws_s3_bucket_server_side_encryption_configuration.accesshub_videos \
  aws_s3_bucket_cors_configuration.accesshub_videos ; do
  terraform state rm "$r"
done

# 2. Import the existing bucket into bootstrap's state (import id = bucket name).
cd ../../bootstrap
terraform import aws_s3_bucket.accesshub_videos accesshub-videos
terraform import aws_s3_bucket_public_access_block.accesshub_videos accesshub-videos
terraform import aws_s3_bucket_policy.accesshub_videos_public_read accesshub-videos
terraform import aws_s3_bucket_server_side_encryption_configuration.accesshub_videos accesshub-videos
terraform import aws_s3_bucket_cors_configuration.accesshub_videos accesshub-videos

# 3. Confirm no destructive drift.
terraform plan      # expect: no changes (or benign tag/config no-ops)
cd ../envs/dev && terraform plan   # expect: the videos bucket is gone from the plan, no destroy
```

Run this once before the next `dev` apply — otherwise dev would plan to destroy the bucket and
bootstrap would fail to create one that already exists. (On a fresh account with no existing
bucket, skip this — `bootstrap` just creates it.)

## Adding a new Lambda

Whenever a new ECR repo is added (e.g. when `sparient-writeback` was added for the
writeback feature), the first `terraform apply` will fail at the `aws_lambda_function`
step because the `:bootstrap` tag doesn't exist on the new repo. Run these once
before pushing to `main`:

```bash
ECR_BASE=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-2.amazonaws.com
aws ecr get-login-password --region us-east-2 --profile sparient | \
  docker login --username AWS --password-stdin $ECR_BASE
terraform apply -target=module.ecr   # creates the new repo
docker pull public.ecr.aws/lambda/nodejs:20
docker tag public.ecr.aws/lambda/nodejs:20 $ECR_BASE/sparient-<new-name>:bootstrap
docker push $ECR_BASE/sparient-<new-name>:bootstrap
terraform apply                       # finishes creating the Lambda
```

After this, CI's normal flow (build → push real image → `aws lambda update-function-code`)
takes over.

## Updating

- **Code + infra:** push to `main`. CI runs tests → terraform apply → prisma migrate → build 5 images → update 5 Lambdas.
- **Manual deploy:** Actions tab → "Deploy (dev)" → "Run workflow".
- **Local fallback** (skip CI): `docker build` + `docker push` + `aws lambda update-function-code`.

## Monthly cost (dev)

| Item | Cost |
|---|---|
| Neon Postgres (free tier) | $0 |
| Step Functions | ~$0 |
| SQS / Lambda / API GW / EventBridge | free tier |
| ECR storage (5 repos) | ~$0.13 |
| CloudWatch Logs | ~$1 |
| **Total** | **~$1/mo** |

## Monthly cost (prod)

| Item | Cost |
|---|---|
| NAT Gateway (single) | ~$32 |
| RDS `db.t4g.small` single-AZ | ~$24 |
| RDS Proxy | ~$15 |
| Secrets Manager (1 secret) | ~$0.40 |
| Lambda / SQS / API GW / EventBridge / migrate | free tier–ish |
| **Total** | **~$72/mo** |

## What Terraform does *not* do

- Build/push Docker images — GitHub Actions CI handles that.
- Create the source + remediated S3 buckets (they exist; request + response buckets are Terraform-managed).
- Create the first institution — run `npm run db:seed` against the Neon connection URI.
- Alert on DLQ depth. Add a CloudWatch alarm later.
