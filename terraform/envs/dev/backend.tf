terraform {
  required_version = ">= 1.6"
  required_providers {
    aws  = { source = "hashicorp/aws",  version = "~> 5.60" }
    neon = { source = "kislerdm/neon",  version = "~> 0.6" }
  }

  # Fill these in after running terraform/bootstrap.
  # The profile here must match the one you want Terraform to use for the state bucket.
  backend "s3" {
    bucket         = "sparient-backend-engine-tfstate-dev"
    key            = "dev/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "sparient-tf-locks"
    encrypt        = true
    # profile is set via -backend-config="profile=sparient" for local runs.
    # CI uses OIDC — no profile needed.
  }
}
