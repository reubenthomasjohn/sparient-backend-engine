terraform {
  required_version = ">= 1.6"
  required_providers {
    aws  = { source = "hashicorp/aws",  version = "~> 5.60" }
    neon = { source = "kislerdm/neon",  version = "~> 0.6" }
  }

  # Same state bucket as envs/dev; different key so they don't collide.
  backend "s3" {
    bucket         = "REPLACE_WITH_STATE_BUCKET"
    key            = "single/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "sparient-tf-locks"
    encrypt        = true
    profile        = "sparient"
  }
}
