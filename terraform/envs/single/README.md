# Single-Lambda deployment (dev trigger / smoke-test env)

Whole engine in one Lambda behind a Function URL. No SQS, no EventBridge, no VPC, no RDS.
Neon Postgres is provisioned by Terraform; image rollouts are driven by GitHub Actions.

## What's in here

| Resource | Purpose |
|---|---|
| **Neon project + branch** | Free-tier managed Postgres, public endpoint |
| **ECR repo** `sparient-monolith` | Stores Lambda images |
| **Lambda** `sparient-single` (arm64, 1 GB, 15-min timeout) | Express app + inline workers |
| **Function URL** | Public HTTPS endpoint, honours the 15-min timeout |
| **OIDC provider + IAM role** | Lets GitHub Actions push images + update the Lambda — no long-lived keys |

## First-time deploy

```bash
# 0. Bootstrap the state bucket once (shared with envs/dev). Skip if already done.
cd ../../bootstrap && terraform apply -var='state_bucket_name=sparient-tfstate-...'
cd ../envs/single

# 1. Create a Neon API key:
#    https://console.neon.tech → Account settings → API keys → New.
#    Export it as a TF_VAR (don't put it in tfvars):
export TF_VAR_neon_api_key=napi_...

# 2. Fill in terraform.tfvars (no neon_api_key here).
cp terraform.tfvars.example terraform.tfvars
# edit — set bucket names and github_repo_name

# 3. Bootstrap image (Terraform needs *something* to create the Lambda with).
#    First apply will fail because the image doesn't exist yet, so apply only the
#    ECR repo first, push a placeholder image, then apply the rest.
terraform init
terraform apply -target=aws_ecr_repository.this

aws ecr get-login-password --region us-east-2 --profile sparient | \
  docker login --username AWS --password-stdin $(terraform output -raw ecr_repo_url)

# Push an empty placeholder so aws_lambda_function can be created. CI replaces this
# on the first push to main.
docker pull public.ecr.aws/lambda/nodejs:20
docker tag public.ecr.aws/lambda/nodejs:20 $(terraform output -raw ecr_repo_url):bootstrap
docker push $(terraform output -raw ecr_repo_url):bootstrap

# 4. Full apply.
terraform apply

# 5. Run migrations against Neon (once).
export DATABASE_URL="$(terraform output -raw neon_connection_uri)"
npm run db:migrate
npm run db:seed

# 6. Wire GitHub Actions.
#    In the repo → Settings → Secrets and variables → Actions → Variables:
#      AWS_ROLE_ARN    = (terraform output -raw github_actions_role_arn)
#      AWS_ACCOUNT_ID  = 882884689403

# 7. Push to the configured deploy branch (default `slim/repo`).
#    The workflow builds, pushes to ECR, and updates the Lambda.
#    Watch progress at: github.com/<owner>/<repo>/actions
git push origin slim/repo

# 8. Hit the endpoint.
curl "$(terraform output -raw function_url)health"
curl -X POST "$(terraform output -raw function_url)api/v1/sync/institutions/<id>?force=true"
```

## Day-to-day

- **Code changes:** push to `slim/repo`. CI takes ~2–3 minutes.
- **Manual redeploy:** Actions tab → "Deploy (single env)" → "Run workflow."
- **Infra changes:** `terraform apply` locally. CI does not own Terraform.
- **Force-sync from Postman:** point the collection's `baseUrl` at the Function URL (drop the trailing `/`).

## Cost

| Item | Cost |
|---|---|
| Lambda invocations + storage | free tier |
| ECR (< 500 MB storage) | ~$0.05 |
| CloudWatch Logs (low volume) | ~$0.50 |
| Neon free tier (0.25 vCPU, 1 GB storage, auto-suspend) | $0 |
| **Total** | **~$1/mo** |

If Neon's free tier auto-suspend (~5 min idle) causes the first request after idle to hang for ~1s on DB wake, bump to a paid Neon compute or keep a warm ping.
