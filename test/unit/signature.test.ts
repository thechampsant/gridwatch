import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signBody, verifySignature } from '../../src/csms/signature.js';

const body = Buffer.from(JSON.stringify({ delivery_id: 'dlv-001', events: [] }));

describe('webhook signature (X-CSMS-Signature)', () => {
  it('accepts hex, sha256=-prefixed and base64 encodings of the HMAC', () => {
    const hex = signBody(body, 's3cret');
    const b64 = createHmac('sha256', 's3cret').update(body).digest('base64');
    expect(verifySignature(body, hex, ['s3cret'])).toBe(true);
    expect(verifySignature(body, `sha256=${hex}`, ['s3cret'])).toBe(true);
    expect(verifySignature(body, b64, ['s3cret'])).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, and a missing header', () => {
    const sig = signBody(body, 's3cret');
    expect(verifySignature(Buffer.from(body.toString().replace('001', '002')), sig, ['s3cret'])).toBe(false);
    expect(verifySignature(body, sig, ['other'])).toBe(false);
    expect(verifySignature(body, undefined, ['s3cret'])).toBe(false);
    expect(verifySignature(body, 'not-a-signature', ['s3cret'])).toBe(false);
  });

  it('accepts the previous secret during a rotation', () => {
    const sig = signBody(body, 'old');
    expect(verifySignature(body, sig, ['new', 'old'])).toBe(true);
  });
});
