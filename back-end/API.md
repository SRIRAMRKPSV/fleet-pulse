# Fleet Pulse backend API

## Configuration

- `PORT` (optional): HTTP port; defaults to `3000`.
- `FRONTEND_ORIGIN` (optional in development): comma-separated exact HTTP(S) origins, for example `http://localhost:4200`. Development defaults to that origin. It is required in production. Origins must not include a path, query, credentials, or fragment.
- `AUTH_TOKEN_SECRET` (required in production): secret of at least 32 characters used to sign access tokens. Development uses a non-production fallback.
- `NODE_ENV=production`: enables the production configuration checks.

Authentication uses bearer tokens, not cookies, so CORS does not enable credentials. Approved origins may send `Content-Type`, `Authorization`, and `Idempotency-Key` (also `X-Idempotency-Key` for compatibility). CORS handles preflight before routes. WebSocket upgrade requests independently validate any supplied `Origin`; non-browser clients that omit the header are accepted.

## Authentication

`POST /api/auth/login` accepts `{"email":"operator@pulse.dev","password":"pulse123"}` or the viewer equivalent (`viewer@pulse.dev`, same demo password). A successful response is:

```json
{
  "success": true,
  "data": {
    "email": "operator@pulse.dev",
    "role": "operator",
    "name": "Operator User",
    "accessToken": "<signed-token>",
    "refreshToken": "<opaque-token>",
    "expiresIn": 900,
    "refreshExpiresIn": 604800
  }
}
```

Send the access token as `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes by default. Refresh tokens last seven days and are held in memory; they are not rotated and are invalidated on logout or server restart.

`POST /api/auth/refresh` accepts the refresh token in the JSON body, not a header:

```json
{"refreshToken":"<refreshToken from login>"}
```

It returns `{"success":true,"data":{"accessToken":"<new-access-token>","expiresIn":900}}`. Missing input returns 400; invalid or expired tokens return 401.

`POST /api/auth/logout` accepts `{"refreshToken":"<refresh-token>"}` and revokes it. Logout is idempotent. Rule reads require either role; create, update, and delete require `operator`.

The demo credentials and in-memory users/rules/tokens are intentionally local-demo behavior, not a production identity or persistence system.

## Services and replay

- `GET /api/services`: current service list (`data` and `count`).
- `GET /api/services/:id`: one service; 404 if unknown.
- `GET /api/services/:id/history`: real in-memory samples, with `timestamp`, `timeLabel`, `p95`, `errRate`, and `rps`. History begins with the service's initial sample and retains up to 300 actual updates.
- `GET /api/services/snapshot`: complete service state, `snapshotAt`, and global `offset`.
- `GET /api/services/replay?since=<offset>`: ordered events strictly after a non-negative integer offset. Each event has `offset`, `serviceId`, per-service `sequence`, `timestamp`, and the service state. For compatibility, `data` and `count` remain the current service snapshot and its count; consume the new `events` array (`replayCount`) for actual replay. Invalid/future offsets return 400.
- Replay history retains the latest 10,000 events in memory. If the requested offset predates retained history, the endpoint returns HTTP 410 (`code: "REPLAY_HISTORY_EXPIRED"`) and includes the full current snapshot in `snapshot.data` and top-level `data`.

Offsets are global and monotonically increase per metric event while the process is running. Per-service sequences increase independently. Both reset on restart; state and replay history are in-memory only. The previous replay contract returned only the current snapshot; clients that need event replay must start consuming `events`. This preserves existing snapshot consumers while making replay data available.

## Streaming

- `GET /api/events`: unauthenticated SSE. A new connection receives a full snapshot; reconnects can send `Last-Event-ID` or `?since=<offset>` to receive replay events before live updates. An expired SSE offset receives a full snapshot event.
- `GET /api/services/replay?since=<offset>` is the polling/replay equivalent.
- `ws://<host>:<port>/ws`: WebSocket starts with a full snapshot. Send `{"type":"replay-request","since":<offset>}` to request event replay. Invalid requests receive an error message; expired history receives a full snapshot.
- Both streaming transports publish metric changes every 500 ms when active. WebSocket server pings run every five seconds and terminate connections after two missed pong intervals.

## Alert rules

`GET /api/rules`, `GET /api/rules/:id`, and `GET /api/rules/check-name?name=...&excludeId=...` require an access token. Mutations also require the operator role.

- `POST /api/rules` creates a rule; valid requests return 201. Optional `Idempotency-Key` (or legacy `X-Idempotency-Key`) is cached for ten minutes. Repeating the same key and payload returns the original result; reusing the key with a different payload returns 409.
- `PUT /api/rules/:id` updates fields including `enabled` to enable/disable a rule.
- `DELETE /api/rules/:id` deletes a rule.

Rule names are required and unique; thresholds and condition values must be finite and non-negative, and warning threshold cannot exceed critical threshold. Validation errors return 400, duplicate names/keys return 409, and missing rules return 404.

## Errors and failure drills

API errors use `{"success":false,"message":"..."}` (with a stable `code` where applicable). Malformed JSON returns 400. `/health` includes process-local failure counters.

Existing assignment chaos query parameters remain available, including `?http=500:50`, `?sse=down`, `?ws=down`, `?ws=silent`, `?ws=drop:20`, `?chaos=shuffle`, `?chaos=dupe`, `?chaos=garbage:5`, and `?token_ttl=5`.
