terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.60" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # Same account as dev — prod reuses the existing state bucket + lock table (both in
  # us-east-2), under a separate key. The backend's region is where the *bucket* lives;
  # it is independent of the region this env deploys to (us-west-2).
  backend "s3" {
    bucket         = "sparient-backend-engine-tfstate-dev"
    key            = "prod/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "sparient-tf-locks"
    encrypt        = true
    # profile is set via -backend-config="profile=sparient" for local runs.
    # CI uses OIDC — no profile needed.
  }
}
