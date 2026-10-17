terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region

  # A real run refuses to touch any other account than the one named. An offline plan has no account to check.
  allowed_account_ids = var.offline_plan ? null : [var.account_id]

  # offline_plan = true lets `terraform plan` run with no credentials and no network call to AWS
  # (scripts/check-terraform-plan-aws.ts does). It is never meant for an apply: nothing it plans is real.
  access_key                  = var.offline_plan ? "offline" : null
  secret_key                  = var.offline_plan ? "offline" : null
  skip_credentials_validation = var.offline_plan
  skip_requesting_account_id  = var.offline_plan
  skip_metadata_api_check     = var.offline_plan
  skip_region_validation      = var.offline_plan
}
