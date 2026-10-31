import { Router, Request, Response } from 'express';
import {
  getAccessTokenTtlSeconds,
  issueTokens,
  REFRESH_TOKEN_TTL_SECONDS,
  revokeRefreshToken,
  useRefreshToken
} from '../token-store';
import { UserRole } from '../models';

const router = Router();

// ============================================================
// Hardcoded users (same credentials as before)
// In a real app, passwords would be hashed (bcrypt etc.)
// ============================================================
const USERS: Array<{ email: string; password: string; role: UserRole; name: string }> = [
  { email: 'operator@pulse.dev', password: 'pulse123', role: 'operator', name: 'Operator User' },
  { email: 'viewer@pulse.dev',   password: 'pulse123', role: 'viewer',   name: 'Viewer User'   }
];

// ============================================================
// POST /api/auth/login
// Returns access token (short-lived) + refresh token (longer-lived)
// ============================================================
router.post('/login', (req: Request, res: Response) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ success: false, message: 'email and password are required' });
    return;
  }
  const { email, password } = body as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    res.status(400).json({ success: false, message: 'email and password are required' });
    return;
  }

  const user = USERS.find(u => u.email === email && u.password === password);

  if (!user) {
    res.status(401).json({ success: false, message: 'Invalid email or password' });
    return;
  }

  const { accessToken, refreshToken } = issueTokens(user);

  res.json({
    success: true,
    data: {
      email: user.email,
      role: user.role,
      name: user.name,
      accessToken,
      refreshToken,
      expiresIn: getAccessTokenTtlSeconds(),
      refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS
    }
  });
});

// ============================================================
// POST /api/auth/refresh
// Accepts a refresh token in the request body.
// Returns a new access token if valid, 401 if not.
// ============================================================
router.post('/refresh', (req: Request, res: Response) => {
  const body = req.body;
  const refreshToken = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { refreshToken?: unknown }).refreshToken
    : undefined;

  if (typeof refreshToken !== 'string' || !refreshToken) {
    res.status(400).json({ success: false, message: 'refreshToken is required' });
    return;
  }

  const result = useRefreshToken(refreshToken);

  if (!result) {
    res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    return;
  }

  res.json({ success: true, data: result });
});

// ============================================================
// POST /api/auth/logout
// Revokes the refresh token so it cannot be reused
// ============================================================
router.post('/logout', (req: Request, res: Response) => {
  const body = req.body;
  const refreshToken = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { refreshToken?: unknown }).refreshToken
    : undefined;
  if (typeof refreshToken === 'string' && refreshToken) {
    revokeRefreshToken(refreshToken);
  }
  res.json({ success: true, message: 'Logged out' });
});

export default router;
