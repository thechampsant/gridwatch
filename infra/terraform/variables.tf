variable "region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "local"
}

variable "aws_endpoint" {
  description = "LocalStack edge endpoint (docker compose sets http://localstack:4566)"
  type        = string
  default     = "http://localhost:4566"
}

variable "csms_connection_id" {
  type    = string
  default = "csms-main"
}

variable "webhook_hmac_secret" {
  description = "Initial webhook HMAC secret (dev value from docker compose; real values are set out of band)"
  type        = string
  sensitive   = true
}

variable "vendor_api_token" {
  type      = string
  sensitive = true
}

variable "raw_archive_retention_days" {
  type    = number
  default = 400
}
