# Terraform bootstrap

Creates the S3 bucket and DynamoDB lock table that every other Terraform stack uses
for remote state. Run once per AWS account.

```bash
cd terraform/bootstrap

# Pick a globally-unique bucket name (bucket names are global across all AWS accounts).
terraform init
terraform apply -var='state_bucket_name=sparient-tfstate-<your-suffix>'
```

Then copy the output values into `../envs/dev/backend.tf` and `../envs/single/backend.tf`.

This stack also creates the **GitHub Actions OIDC provider** (account-level singleton) so both env stacks can attach IAM roles to it via a `data` lookup.

The state for bootstrap itself lives in `terraform.tfstate` next to this file.
Don't commit it. It only contains the bucket + table names, which are not secrets,
but also don't need to be in source control.
