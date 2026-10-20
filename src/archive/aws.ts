import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

// AWS clients, pointed at LocalStack in docker compose (AWS_ENDPOINT_URL).
// Credentials come from the default provider chain (env vars locally, an IAM
// role in a real deployment).

export function s3Client(): S3Client {
  return new S3Client({ region: config.awsRegion(), endpoint: config.awsEndpoint(), forcePathStyle: true });
}

export interface SecretProvider {
  // Every currently valid value: the current secret first, then the previous
  // one while a rotation is in progress.
  get(ref: string): Promise<string[]>;
}

export class SecretsManagerProvider implements SecretProvider {
  private readonly client = new SecretsManagerClient({ region: config.awsRegion(), endpoint: config.awsEndpoint() });
  private readonly cache = new Map<string, { values: string[]; until: number }>();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  async get(ref: string): Promise<string[]> {
    const hit = this.cache.get(ref);
    if (hit && hit.until > Date.now()) return hit.values;
    const out = await this.client.send(new GetSecretValueCommand({ SecretId: ref }));
    const values = parseSecret(out.SecretString ?? '');
    this.cache.set(ref, { values, until: Date.now() + this.ttlMs });
    return values;
  }
}

// Secret format: {"current": "...", "previous": "..."} or a plain string.
export function parseSecret(raw: string): string[] {
  try {
    const j = JSON.parse(raw) as { current?: string; previous?: string };
    return [j.current, j.previous].filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return raw ? [raw] : [];
  }
}

export class StaticSecretProvider implements SecretProvider {
  constructor(private readonly values: string[]) {}
  async get(): Promise<string[]> {
    return this.values;
  }
}

export async function putRawObject(s3: S3Client, bucket: string, key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
}
