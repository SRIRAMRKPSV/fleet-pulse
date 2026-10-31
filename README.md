# Fleet Pulse 🚀

Real-time microservice fleet monitoring and operations dashboard built with **Angular 21** and a **Node.js (Express + TypeScript + WebSocket)** backend.

---

## Architecture Overview

```
fleet-pulse/
├── back-end/                # Node.js + Express + TypeScript + ws
│   ├── src/
│   │   ├── models.ts        # Data interfaces
│   │   ├── dummy-data.ts    # 2,000 services generator & default rules
│   │   ├── services-store.ts# In-memory service store + 500ms metric randomizer
│   │   ├── rules-store.ts   # In-memory alert rules CRUD
│   │   ├── websocket.ts     # WebSocket server (ws://localhost:3000/ws)
│   │   ├── server.ts        # Express app entrypoint (port 3000)
│   │   └── routes/
│   │       ├── services.route.ts # GET /api/services, GET /api/services/:id
│   │       ├── rules.route.ts    # CRUD /api/rules
│   │       ├── auth.route.ts     # POST /api/auth/login
│   │       └── events.route.ts   # GET /api/events (Server-Sent Events fallback)
│   └── package.json
│
├── frontend/                # Angular 21 Standalone Components & Signals
│   ├── src/app/
│   │   ├── core/            # Models, guards, services (Auth, MetricsStream, RulesEngine)
│   │   ├── features/        # Fleet table (CDK virtual scroll), Service detail (Chart.js), Rules, Auth
│   │   └── shared/          # Header, Toast notifications
│   └── package.json
└── package.json             # Root helper scripts
```

---

## Transports & Resilience (Per Brief E1 & E2)

1. **WebSocket (Primary)**: `ws://localhost:3000/ws` — pushes metric updates for randomly chosen services every 500ms.
2. **Server-Sent Events (Fallback 1)**: `http://localhost:3000/api/events` — streams metrics when WebSocket fails.
3. **HTTP Polling (Fallback 2)**: `http://localhost:3000/api/services` every 2s — if both streaming transports fail.
4. **Local Fallback**: Frontend continues running seamless simulation if backend is completely offline.

---

## How to Run

### 1. Start the Backend (Port 3000)
```bash
cd back-end
npm install
npm run build
npm start
```
*Backend will be running at `http://localhost:3000` with WebSocket at `ws://localhost:3000/ws`.*

### 2. Start the Frontend (Port 4200)
```bash
cd frontend
npm install
npm start
```
*Frontend opens at `http://localhost:4200`.*

---

## Test Credentials

| Email | Password | Role | Permissions |
|---|---|---|---|
| `operator@pulse.dev` | `pulse123` | **Operator** | Full access (View, create/edit alert rules, trigger chaos drills) |
| `viewer@pulse.dev` | `pulse123` | **Viewer** | Read-only access (Blocked from creating/editing rules) |

---

## Testing

```bash
cd frontend
npx ng test --no-watch
```
All 18 unit tests pass across 5 test suites.
=======
# fleet-pulse