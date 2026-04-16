# Terraform

Deploys the engine to AWS: VPC, RDS + RDS Proxy, SQS, ECR, 3 Lambdas (api, discovery, upload),
API Gateway HTTP API, and an EventBridge rule that kicks off the daily sweep.

## Layout

```
terraform/
├── bootstrap/        # run once: creates S3 state bucket + DynamoDB lock table
├── envs/dev/         # the dev environment (only environment for now)
└── modules/
    ├── networking/   # VPC + 2 public + 2 private subnets + single NAT GW
    ├── database/     # RDS Postgres + RDS Proxy + SSM param for password
    ├── queues/       # 2 SQS queues + 2 DLQs
    ├── ecr/          # 3 ECR repos with lifecycle "keep last 5"
    ├── lambda-api/   # api Lambda + API Gateway HTTP API + provisioned concurrency
    ├── lambda-worker/# generic SQS-triggered worker Lambda (used for discovery + upload)
    └── schedule/     # EventBridge rule → SQS
```

## First-time deploy

```bash
# 1. Bootstrap (once per AWS account).
cd terraform/bootstrap
terraform init
terraform apply -var='state_bucket_name=sparient-tfstate-<suffix>'

# 2. Fill in envs/dev/backend.tf with the bucket name from step 1.

# 3. Copy the tfvars template and edit the bucket + image URIs.
cd ../envs/dev
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars

# 4. Create ECR repos first so images have somewhere to go.
terraform init
terraform apply -target=module.ecr

# 5. Push a bootstrap placeholder image so Lambda can be created.
ECR_URL=$(terraform output -raw ecr_repo_urls | jq -r '.["sparient-api"]' | cut -d/ -f1)
aws ecr get-login-password --region us-east-2 --profile sparient | \
  docker login --username AWS --password-stdin $ECR_URL
for repo in sparient-api sparient-discovery sparient-upload sparient-responses; do
  docker pull --platform linux/arm64 public.ecr.aws/lambda/nodejs:20
  docker tag public.ecr.aws/lambda/nodejs:20 $ECR_URL/$repo:bootstrap
  docker push $ECR_URL/$repo:bootstrap
done

# 6. Full apply.
terraform apply

# 7. Run Prisma migrations against RDS. Since RDS is private, run these from a
#    Session Manager port-forward or a one-shot Lambda. Simplest for dev:
#    temporarily set publicly_accessible=true, migrate, flip it back.

# 8. Seed the first institution.

# 9. Push to main — CI builds real images and updates the Lambdas.
# 10. Hit the API.
curl "$(terraform output -raw api_endpoint)/health"
```

## Updating

- **Code only:** push to the env's deploy branch — `main` for `envs/dev`, `slim/repo` for
  `envs/single`. CI builds, pushes to ECR, and updates the Lambdas. See
  `.github/workflows/deploy-dev.yml` and `deploy-single.yml`.
- **Manual deploy:** Actions tab → "Run workflow" on either workflow.
- **Local fallback** (skip CI): `docker build` + `docker push` + `aws lambda update-function-code`.
- **Infra:** edit Terraform, `terraform plan`, `terraform apply` locally. CI does not own infra.

## Picking which env to deploy

| Want to deploy | Branch | Workflow file |
|---|---|---|
| Single Lambda + Neon (cheap dev trigger) | `slim/repo` | `deploy-single.yml` |
| Full SQS + RDS Proxy stack | `main` | `deploy-dev.yml` |

Both workflows have a manual `workflow_dispatch` button, so you can also fire either one
from the Actions tab without committing.

After running `terraform apply` in each env, set these GitHub Actions Variables (repo →
Settings → Secrets and variables → Actions → Variables):

- `AWS_ACCOUNT_ID` = `882884689403`
- `AWS_ROLE_ARN` = output `github_actions_role_arn` from `envs/single`
- `AWS_ROLE_ARN_DEV` = output `github_actions_role_arn` from `envs/dev`

## Monthly cost estimate (dev)

| Item | Cost |
|---|---|
| NAT Gateway (1 AZ) | ~$32 |
| RDS db.t4g.micro + 20 GB gp3 | ~$15 |
| RDS Proxy | ~$15 |
| Provisioned concurrency on API (1 × 1 GB) | ~$5 |
| SQS / Lambda / API GW / EventBridge | free tier |
| Secrets Manager (1 secret for DB Proxy) | ~$0.40 |
| CloudWatch Logs | ~$1 |
| **Total** | **~$68/mo** |

## What Terraform does *not* do

- Build/push Docker images — GitHub Actions CI handles that.
- Create the source + remediated S3 buckets (they exist; Terraform just references them by name).
- Create the first institution — run `npm run db:seed` against the RDS endpoint.
- Alert on DLQ depth. Add a CloudWatch alarm later.
