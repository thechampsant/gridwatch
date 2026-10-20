output "raw_archive_bucket" {
  value = aws_s3_bucket.raw_archive.bucket
}

output "webhook_secret_name" {
  value = aws_secretsmanager_secret.webhook_hmac.name
}

output "vendor_api_token_secret_name" {
  value = aws_secretsmanager_secret.vendor_api_token.name
}
