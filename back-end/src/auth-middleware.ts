import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from './token-store';
import { TokenPayload } from './token-store';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

// ============================================================
// authMiddleware
// Verifies the Bearer token sent in Authorization header.
// Attaches user info to req if valid, returns 401 if not.
// ============================================================
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7); // Remove "Bearer "
  const payload = verifyAccessToken(token);

  if (!payload) {
    res.status(401).json({ success: false, message: 'Invalid or expired access token' });
    return;
  }

  // Attach user info for downstream route handlers
  req.user = payload;
  next();
}

// ============================================================
// operatorOnly
// Use after authMiddleware to restrict write routes to operators
// ============================================================
export function operatorOnly(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user || user.role !== 'operator') {
    res.status(403).json({ success: false, message: 'Forbidden: operator role required' });
    return;
  }
  next();
}
