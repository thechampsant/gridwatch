import { jwtVerify, SignJWT } from 'jose';
import type { TenantContext } from '../db/pool.js';

// The tenant comes only from a verified token. In production the token is
// issued by Keycloak (RS256, keys from its JWKS endpoint); the slice signs
// HS256 tokens locally with the same claims so the API code path is identical.
const ISSUER = 'gridwatch-dev';
const AUDIENCE = 'gridwatch-api';

const key = (secret: string) => new TextEncoder().encode(secret);

export async function issueToken(
  secret: string,
  claims: { sub: string; role: TenantContext['role']; operator_id?: string },
  ttl = '8h',
): Promise<string> {
  const payload: Record<string, string> = { role: claims.role };
  if (claims.operator_id) payload.operator_id = claims.operator_id;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key(secret));
}

export class AuthError extends Error {}

export async function verifyToken(secret: string, authorization: string | undefined): Promise<TenantContext> {
  const m = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!m) throw new AuthError('missing bearer token');
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(m[1]!, key(secret), { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] }));
  } catch (err) {
    throw new AuthError(`invalid token: ${(err as Error).message}`);
  }
  const role = payload.role;
  const subject = typeof payload.sub === 'string' ? payload.sub : 'unknown';
  if (role === 'platform_admin') return { subject, role, operatorId: null };
  if (role === 'operator' && typeof payload.operator_id === 'string' && payload.operator_id) {
    return { subject, role, operatorId: payload.operator_id };
  }
  throw new AuthError('token has no usable role / operator_id claim');
}
