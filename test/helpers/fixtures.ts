import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

export function stub<T = any>(name: string): T {
  return JSON.parse(readFileSync(path.join(root, 'fixtures/stubs', name), 'utf8')) as T;
}

export const STUBS = {
  page1: '1a-poll-page1.json',
  page2: '1b-poll-page2-final.json',
  rateLimited: '1c-rate-limited.json',
  serverError: '1d-server-error.json',
  malformed: '1e-malformed-page.json',
  webhookNormal: '2a-webhook-normal.json',
  webhookDuplicate: '2b-webhook-duplicate.json',
  webhookOutOfOrder: '2c-webhook-out-of-order.json',
  webhookMeterReset: '2d-webhook-meter-reset.json',
  pilotFaultPage: 'pilot-S-IN-0012-fault-page.json',
} as const;

export const repoRoot = root;
