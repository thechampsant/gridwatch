# Cloud-style resources for the slice, applied to LocalStack by docker compose.
# The same module targets real AWS by changing the provider settings and
# moving state to an S3 backend with locking (see README).

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region     = var.region
  access_key = "test"
  secret_key = "test"

  # LocalStack: path-style S3 and no calls to real AWS metadata/STS/IAM.
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    s3             = var.aws_endpoint
    secretsmanager = var.aws_endpoint
    sts            = var.aws_endpoint
  }

  default_tags {
    tags = {
      project     = "gridwatch"
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}

# Raw vendor payload archive: every webhook batch and poll page, as received.
# Used for billing disputes ("show me the event that produced this invoice")
# and for replaying history into a rebuilt store.
resource "aws_s3_bucket" "raw_archive" {
  bucket        = "gridwatch-raw-archive-${var.environment}"
  force_destroy = var.environment == "local"
}

resource "aws_s3_bucket_versioning" "raw_archive" {
  bucket = aws_s3_bucket.raw_archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "raw_archive" {
  bucket = aws_s3_bucket.raw_archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # aws:kms with a customer-managed key in a real account
    }
  }
}

resource "aws_s3_bucket_public_access_block" "raw_archive" {
  bucket                  = aws_s3_bucket.raw_archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Hot for a month, then cold storage; kept long enough to cover invoice
# disputes. The legal retention period for invoices (8-10 years in Germany,
# about 6 in India) applies to settlement data in the database, not to these
# raw payloads.
resource "aws_s3_bucket_lifecycle_configuration" "raw_archive" {
  bucket = aws_s3_bucket.raw_archive.id
  rule {
    id     = "tiering"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "GLACIER"
    }
    expiration {
      days = var.raw_archive_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# Secrets live in Secrets Manager, never in code or images. JSON with
# "current" and (during a rotation) "previous": the webhook receiver accepts
# either, so a secret can be rotated without dropping deliveries.
resource "aws_secretsmanager_secret" "webhook_hmac" {
  name                    = "gridwatch/${var.csms_connection_id}/webhook-hmac"
  description             = "Shared HMAC secret for X-CSMS-Signature on vendor webhooks"
  recovery_window_in_days = var.environment == "local" ? 0 : 30
}

resource "aws_secretsmanager_secret_version" "webhook_hmac" {
  secret_id     = aws_secretsmanager_secret.webhook_hmac.id
  secret_string = jsonencode({ current = var.webhook_hmac_secret })
}

resource "aws_secretsmanager_secret" "vendor_api_token" {
  name                    = "gridwatch/${var.csms_connection_id}/api-token"
  description             = "Credential for the vendor CSMS poll API"
  recovery_window_in_days = var.environment == "local" ? 0 : 30
}

resource "aws_secretsmanager_secret_version" "vendor_api_token" {
  secret_id     = aws_secretsmanager_secret.vendor_api_token.id
  secret_string = jsonencode({ current = var.vendor_api_token })
}
