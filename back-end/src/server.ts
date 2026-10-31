import express from 'express';
import cors from 'cors';
import http from 'http';
import { isAllowedFrontendOrigin } from './origin-config';

// Import all route files
import servicesRoute from './routes/services.route';
import rulesRoute    from './routes/rules.route';
import authRoute     from './routes/auth.route';
import eventsRoute   from './routes/events.route';

// Import WebSocket setup
import { setupWebSocket } from './websocket';
import { getFailureCounts, recordFailure } from './failure-counters';

// Import chaos middleware (failure drills support)
import { chaosMidleware } from './chaos-middleware';

// ============================================================
// Create the Express app
// ============================================================
const app = express();
const PORT = Number(process.env.PORT || 4000);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

// ============================================================
// Middleware
// CORS            → allows only configured frontend origins
// express.json() → reads JSON from request body
// chaosMidleware → parses ?ws=down&http=500:50 etc. for failure drills
// ============================================================
app.use(cors({
  origin: (origin, callback) => {
    callback(null, Boolean(origin && isAllowedFrontendOrigin(origin)));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'X-Idempotency-Key'
  ],
  optionsSuccessStatus: 204
}));
app.use(express.json({
  limit: '1mb'
}));
app.use(chaosMidleware);

// ============================================================
// Root route
// GET / → shows all available API endpoints
// ============================================================
app.get('/', (req, res) => {
  res.json({
    name: 'Fleet Pulse Backend',
    status: 'running',
    version: '2.0',
    endpoints: {
      health:      'GET  /health',
      services:    'GET  /api/services',
      snapshot:    'GET  /api/services/snapshot',
      replay:      'GET  /api/services/replay?since=<offset>',
      service:     'GET  /api/services/:id',
      history:     'GET  /api/services/:id/history',
      rules:       'GET  /api/rules         (auth required)',
      createRule:  'POST /api/rules          (operator only, Idempotency-Key/X-Idempotency-Key supported)',
      updateRule:  'PUT  /api/rules/:id      (operator only)',
      deleteRule:  'DELETE /api/rules/:id    (operator only)',
      checkName:   'GET  /api/rules/check-name?name=X (auth required)',
      login:       'POST /api/auth/login',
      refresh:     'POST /api/auth/refresh',
      logout:      'POST /api/auth/logout',
      sse:         'GET  /api/events         (Server-Sent Events — auth not required; supports Last-Event-ID/since)',
      websocket:   `ws://localhost:${PORT}/ws`,
      chaos: {
        wsDown:    '?ws=down',
        wsSilent:  '?ws=silent',
        wsDrop:    '?ws=drop:20',
        sseDown:   '?sse=down',
        httpError: '?http=500:50',
        tokenTtl:  '?token_ttl=5',
        shuffle:   '?chaos=shuffle',
        dupe:      '?chaos=dupe',
        garbage:   '?chaos=garbage:5'
      }
    }
  });
});

// ============================================================
// Routes
// ============================================================
app.use('/api/services', servicesRoute);   // GET /api/services, snapshot, replay, :id, :id/history
app.use('/api/rules', rulesRoute);          // GET/POST/PUT/DELETE /api/rules  (auth-protected writes)
app.use('/api/auth', authRoute);            // POST /api/auth/login, /refresh, /logout
app.use('/api/events', eventsRoute);        // GET /api/events  (SSE fallback)

// ============================================================
// Health Check
// GET /health → confirms server is running
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), failures: getFailureCounts() });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const err = error && typeof error === 'object'
    ? error as { status?: unknown; type?: unknown; message?: unknown }
    : {};
  const isMalformedJson = err.type === 'entity.parse.failed';
  const clientStatus = typeof err.status === 'number' && err.status >= 400 && err.status <= 499
    ? err.status
    : null;
  const status = isMalformedJson ? 400 : (clientStatus ?? 500);
  if (status === 400) {
    recordFailure('malformedJson');
  } else if (status >= 500) {
    console.error('Unhandled request error:', error);
    recordFailure('httpServerError');
  } else {
    recordFailure('invalidHttpRequest');
  }
  res.status(status).json({
    success: false,
    message: isMalformedJson
      ? 'Malformed JSON request body'
      : (status === 413 ? 'Request body is too large' : (status < 500 ? 'Invalid request' : 'Internal server error'))
  });
});

// ============================================================
// Start the HTTP server
// WebSocket is attached to the same HTTP server
// ============================================================
const httpServer = http.createServer(app);

// Attach WebSocket on the same configured port
setupWebSocket(httpServer, PORT);

httpServer.listen(PORT, () => {
  console.log('');
  console.log('  Fleet Pulse Backend v2.0 running');
  console.log(`  REST API  → http://localhost:${PORT}/api`);
  console.log(`  WebSocket → ws://localhost:${PORT}/ws`);
  console.log(`  SSE       → http://localhost:${PORT}/api/events`);
  console.log(`  Health    → http://localhost:${PORT}/health`);
  console.log('  Auth      → POST /api/auth/login | POST /api/auth/refresh');
  console.log('');
});
