import { Request, Response, NextFunction } from 'express';
import { setAccessTokenTTL } from './token-store';
import { recordFailure } from './failure-counters';

// ============================================================
// chaos-middleware.ts
//
// Parses chaos query-string parameters for failure drills.
// Apply this middleware to every HTTP request so the
// frontend can test resilience scenarios.
//
// Supported parameters:
//   http=500:50        → return HTTP 500 on 50% of requests
//   token_ttl=5        → set access token TTL to 5 seconds
//   sse=down           → return 503 on SSE requests
//   chaos=garbage:5    → inject malformed JSON every 5 events
//
// WebSocket chaos is handled separately in websocket.ts:
//   ws=down            → reject WebSocket upgrades
//   ws=silent          → accept but never send messages
//   ws=drop:20         → drop 20% of messages
//   chaos=shuffle      → scramble service IDs in updates
//   chaos=dupe         → send same event twice
// ============================================================

export interface ChaosConfig {
  httpErrorRate: number;   // 0-100, % of requests to return 500
  sseDown: boolean;        // return 503 on SSE endpoint
  wsDown: boolean;         // reject WebSocket upgrades
  wsSilent: boolean;       // accept WS but never send
  wsDropRate: number;      // 0-100, % of WS messages to drop
  shuffle: boolean;        // shuffle service IDs in updates
  dupe: boolean;           // send each WS update twice
  garbageEvery: number;    // inject malformed JSON every N events (0 = disabled)
}

// Shared mutable config — set by chaos middleware, read by websocket.ts
export const chaosConfig: ChaosConfig = {
  httpErrorRate: 0,
  sseDown: false,
  wsDown: false,
  wsSilent: false,
  wsDropRate: 0,
  shuffle: false,
  dupe: false,
  garbageEvery: 0
};

export function chaosMidleware(req: Request, res: Response, next: NextFunction): void {
  const queryValue = (key: string): string | undefined => {
    const value = req.query[key];
    return typeof value === 'string' ? value : undefined;
  };
  const http = queryValue('http');
  const ws = queryValue('ws');
  const chaos = queryValue('chaos');

  // http=500:N
  if (http) {
    const parts = http.split(':');
    const rate = Number(parts[1]);
    if (parts.length === 2 && parts[0] === '500' && Number.isInteger(rate) && rate >= 0 && rate <= 100) {
      chaosConfig.httpErrorRate = rate;
    } else {
      chaosConfig.httpErrorRate = 0;
    }
  } else {
    chaosConfig.httpErrorRate = 0;
  }

  // sse=down
  chaosConfig.sseDown = queryValue('sse') === 'down';

  // ws=down / ws=silent / ws=drop:N
  if (ws === 'down') {
    chaosConfig.wsDown = true;
    chaosConfig.wsSilent = false;
  } else if (ws === 'silent') {
    chaosConfig.wsSilent = true;
    chaosConfig.wsDown = false;
  } else if (ws?.startsWith('drop:')) {
    const rate = Number(ws.slice(5));
    chaosConfig.wsDropRate = Number.isInteger(rate) && rate >= 0 && rate <= 100 ? rate : 0;
    chaosConfig.wsDown = false;
    chaosConfig.wsSilent = false;
  } else {
    chaosConfig.wsDown = false;
    chaosConfig.wsSilent = false;
    chaosConfig.wsDropRate = 0;
  }

  // chaos=shuffle,dupe  OR  chaos=garbage:5
  if (chaos) {
    const parts = chaos.split(',');
    chaosConfig.shuffle = parts.includes('shuffle');
    chaosConfig.dupe    = parts.includes('dupe');
    const garbagePart = parts.find(p => p.startsWith('garbage:'));
    const every = garbagePart ? Number(garbagePart.slice('garbage:'.length)) : 0;
    chaosConfig.garbageEvery = Number.isSafeInteger(every) && every > 0 ? every : 0;
  } else {
    chaosConfig.shuffle = false;
    chaosConfig.dupe    = false;
    chaosConfig.garbageEvery = 0;
  }

  // token_ttl=5  (one-time setter)
  const tokenTtl = queryValue('token_ttl');
  if (tokenTtl) {
    const ttl = Number(tokenTtl);
    if (Number.isSafeInteger(ttl) && ttl > 0) {
      setAccessTokenTTL(ttl);
    }
  }

  // Apply http error injection (skip auth, health, chaos endpoints themselves)
  const isSkipped = req.path.includes('/auth') || req.path.includes('/health');
  if (!isSkipped && chaosConfig.httpErrorRate > 0) {
    if (Math.random() * 100 < chaosConfig.httpErrorRate) {
      recordFailure('injectedHttpError');
      res.status(500).json({ success: false, message: '[Chaos] Injected HTTP 500 error' });
      return;
    }
  }

  // Block SSE when sse=down
  if (chaosConfig.sseDown && req.path.includes('/events')) {
    recordFailure('injectedSseFailure');
    res.status(503).json({ success: false, message: '[Chaos] SSE transport is disabled (sse=down)' });
    return;
  }

  next();
}
