import { createHmac, timingSafeEqual } from 'node:crypto';

// X-CSMS-Signature: HMAC-SHA256 of the raw request body with a shared secret.
// The stub doesn't say hex or base64 (a question for the vendor), so both are
// accepted, with or without a "sha256=" prefix. Several secrets may be valid
// at once so the secret can be rotated without dropping deliveries.

export function signBody(body: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function decodeSignature(header: string): Buffer | null {
  const v = header.trim().replace(/^sha256=/i, '');
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(v)) {
    const b = Buffer.from(v, 'base64');
    return b.length === 32 ? b : null;
  }
  return null;
}

export function verifySignature(body: Buffer, header: string | undefined, secrets: string[]): boolean {
  if (!header) return false;
  const provided = decodeSignature(header);
  if (!provided) return false;
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(body).digest();
    // Constant-time compare; lengths are equal (both 32 bytes) by construction.
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) ok = true;
  }
  return ok;
}
