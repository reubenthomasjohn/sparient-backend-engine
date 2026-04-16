# Terraform

Deploys the engine to AWS: Neon Postgres, SQS, ECR, 4 Lambdas (api, discovery, course-workflow, responses),
Step Functions, API Gateway HTTP API, and an EventBridge tick (every 15 min).

## Layout

```
terraform/
├── bootstrap/        # run once: creates S3 state bucket + DynamoDB lock table + OIDC provider
├── envs/dev/         # the dev environment
└── modules/
    ├── networking/   # VPC (unused in dev — reserved for prod RDS setup)
    ├── database/     # RDS + RDS Proxy (unused in dev — reserved for prod)
    ├── queues/       # discovery SQS queue + DLQ
    ├── ecr/          # 4 ECR repos with lifecycle "keep last 5"
    ├── lambda-api/   # api Lambda + API Gateway HTTP API
    ├── lambda-worker/# generic SQS-triggered worker Lambda (discovery, responses)
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
for repo in sparient-api sparient-discovery sparient-course-workflow sparient-responses; do
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

## Updating

- **Code + infra:** push to `main`. CI runs terraform apply → prisma migrate → build 4 images → update 4 Lambdas.
- **Manual deploy:** Actions tab → "Deploy (dev)" → "Run workflow".
- **Local fallback** (skip CI): `docker build` + `docker push` + `aws lambda update-function-code`.

## Monthly cost (dev)

| Item | Cost |
|---|---|
| Neon Postgres (free tier) | $0 |
| Step Functions | ~$0 |
| SQS / Lambda / API GW / EventBridge | free tier |
| ECR storage (4 repos) | ~$0.10 |
| CloudWatch Logs | ~$1 |
| **Total** | **~$1/mo** |

## What Terraform does *not* do

- Build/push Docker images — GitHub Actions CI handles that.
- Create the source + remediated S3 buckets (they exist; request + response buckets are Terraform-managed).
- Create the first institution — run `npm run db:seed` against the Neon connection URI.
- Alert on DLQ depth. Add a CloudWatch alarm later.
