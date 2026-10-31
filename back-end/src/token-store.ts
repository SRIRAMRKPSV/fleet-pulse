import crypto from 'crypto';
import { UserRole } from './models';

const developmentSecret = 'fleet-pulse-development-only-secret';
const configuredSecret = process.env.AUTH_TOKEN_SECRET;

if (process.env.NODE_ENV === 'production' && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error('AUTH_TOKEN_SECRET must contain at least 32 characters in production');
}

const SECRET = configuredSecret || developmentSecret;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_SECONDS = REFRESH_TOKEN_TTL_MS / 1000;
let accessTokenTtlMs = 15 * 60 * 1000;

interface StoredRefreshToken {
  user: Pick<TokenPayload, 'email' | 'role' | 'name'>;
  expiresAt: number;
}

const refreshTokenStore = new Map<string, StoredRefreshToken>();

export interface TokenPayload {
  email: string;
  role: UserRole;
  name: string;
  iat: number;
  exp: number;
}

export function getAccessTokenTtlSeconds(): number {
  return Math.floor(accessTokenTtlMs / 1000);
}

export function setAccessTokenTTL(ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Access token TTL must be a positive number of seconds');
  }
  accessTokenTtlMs = ttlSeconds * 1000;
  console.log(`[TokenStore] Access token TTL set to ${ttlSeconds}s`);
}

export function issueTokens(user: { email: string; role: UserRole; name: string }): {
  accessToken: string;
  refreshToken: string;
} {
  const now = Date.now();
  const payload: TokenPayload = {
    ...user,
    iat: now,
    exp: now + accessTokenTtlMs
  };
  const accessToken = signToken(payload);
  const refreshToken = crypto.randomBytes(32).toString('hex');
  refreshTokenStore.set(refreshToken, {
    user: { email: user.email, role: user.role, name: user.name },
    expiresAt: now + REFRESH_TOKEN_TTL_MS
  });
  return { accessToken, refreshToken };
}

export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

    const [encodedPayload, signature] = parts;
    if (!timingSafeEqual(signature, hmac(encodedPayload))) return null;

    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'));
    if (!isTokenPayload(payload) || Date.now() >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function useRefreshToken(refreshToken: string): {
  accessToken: string;
  expiresIn: number;
} | null {
  const stored = refreshTokenStore.get(refreshToken);
  if (!stored) return null;
  if (Date.now() >= stored.expiresAt) {
    refreshTokenStore.delete(refreshToken);
    return null;
  }

  const now = Date.now();
  const payload: TokenPayload = {
    ...stored.user,
    iat: now,
    exp: now + accessTokenTtlMs
  };
  return {
    accessToken: signToken(payload),
    expiresIn: getAccessTokenTtlSeconds()
  };
}

export function revokeRefreshToken(refreshToken: string): void {
  refreshTokenStore.delete(refreshToken);
}

function isTokenPayload(value: unknown): value is TokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<TokenPayload>;
  return typeof payload.email === 'string'
    && typeof payload.name === 'string'
    && (payload.role === 'viewer' || payload.role === 'operator')
    && typeof payload.iat === 'number'
    && Number.isFinite(payload.iat)
    && typeof payload.exp === 'number'
    && Number.isFinite(payload.exp);
}

function signToken(payload: TokenPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `${encodedPayload}.${hmac(encodedPayload)}`;
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', SECRET).update(data).digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
