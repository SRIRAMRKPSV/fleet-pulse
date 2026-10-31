import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import {
  getAll,
  getEventsAfter,
  getLatestOffset,
  getServiceSequences,
  updateMetrics
} from './services-store';
import { MetricEvent, StreamUpdate } from './models';
import { chaosConfig } from './chaos-middleware';
import { isAllowedFrontendOrigin } from './origin-config';
import { recordFailure } from './failure-counters';

interface ClientChaos {
  silent: boolean;
  dropRate: number;
  shuffle: boolean;
  dupe: boolean;
  garbageEvery: number;
  eventsSinceGarbage: number;
}

const clientChaos = new WeakMap<WebSocket, ClientChaos>();

export function setupWebSocket(httpServer: Server, port: number): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const origin = request.headers.origin;
    if (origin && !isAllowedFrontendOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.searchParams.get('ws') === 'down' || chaosConfig.wsDown) {
      console.log('[Chaos] ws=down: rejecting WebSocket upgrade');
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });

  let broadcastTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const missedPongs = new WeakMap<WebSocket, number>();

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    console.log(`WebSocket client connected. Total: ${wss.clients.size}`);
    missedPongs.set(socket, 0);

    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const wsMode = requestUrl.searchParams.get('ws') || '';
    const chaosOptions = (requestUrl.searchParams.get('chaos') || '').split(',');
    const dropRate = wsMode.startsWith('drop:') ? Number(wsMode.slice(5)) : 0;
    const garbageOption = chaosOptions.find(option => option.startsWith('garbage:'));
    const garbageEvery = garbageOption ? Number(garbageOption.slice('garbage:'.length)) : 0;
    const settings: ClientChaos = {
      silent: wsMode === 'silent',
      dropRate: Number.isInteger(dropRate) && dropRate >= 0 && dropRate <= 100 ? dropRate : 0,
      shuffle: chaosOptions.includes('shuffle'),
      dupe: chaosOptions.includes('dupe'),
      garbageEvery: Number.isSafeInteger(garbageEvery) && garbageEvery > 0 ? garbageEvery : 0,
      eventsSinceGarbage: 0
    };
    clientChaos.set(socket, settings);

    if (!settings.silent && !chaosConfig.wsSilent) {
      sendJson(socket, {
        type: 'metrics-update',
        updatedServices: getAll(),
        timestamp: Date.now(),
        offset: getLatestOffset(),
        snapshot: true,
        sequences: getServiceSequences()
      });
    }

    socket.on('pong', () => missedPongs.set(socket, 0));
    socket.on('ping', () => socket.pong());
    socket.on('message', data => handleClientMessage(socket, data.toString()));

    socket.on('close', () => {
      console.log(`WebSocket client disconnected. Total: ${wss.clients.size}`);
      missedPongs.delete(socket);
      if (wss.clients.size === 0) {
        if (broadcastTimer) {
          clearInterval(broadcastTimer);
          broadcastTimer = null;
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }
    });

    socket.on('error', error => {
      recordFailure('websocketError');
      console.error('WebSocket error:', error.message);
    });

    if (!broadcastTimer) broadcastTimer = startBroadcasting(wss);
    if (!heartbeatTimer) heartbeatTimer = startHeartbeat(wss, missedPongs);
  });

  console.log(`WebSocket server ready at ws://localhost:${port}/ws`);
}

function handleClientMessage(socket: WebSocket, rawMessage: string): void {
  let message: unknown;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    recordFailure('invalidWebSocketMessage');
    sendJson(socket, { type: 'error', success: false, code: 'INVALID_MESSAGE', message: 'Message must be valid JSON' });
    return;
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    recordFailure('invalidWebSocketMessage');
    sendJson(socket, { type: 'error', success: false, code: 'INVALID_MESSAGE', message: 'Message must be a JSON object' });
    return;
  }

  const payload = message as { type?: unknown; since?: unknown };
  if (payload.type !== 'replay-request') {
    recordFailure('invalidWebSocketMessage');
    sendJson(socket, { type: 'error', success: false, code: 'UNSUPPORTED_MESSAGE', message: 'Only replay-request is supported' });
    return;
  }
  if (typeof payload.since !== 'number' || !Number.isSafeInteger(payload.since) || payload.since < 0) {
    recordFailure('invalidReplayOffset');
    sendJson(socket, { type: 'error', success: false, code: 'INVALID_REPLAY_OFFSET', message: 'since must be a non-negative integer' });
    return;
  }

  const replay = getEventsAfter(payload.since);
  if (payload.since > replay.latestOffset) {
    recordFailure('invalidReplayOffset');
    sendJson(socket, {
      type: 'error',
      success: false,
      code: 'INVALID_REPLAY_OFFSET',
      message: 'since cannot be greater than the latest stream offset',
      latestOffset: replay.latestOffset
    });
    return;
  }

  if (replay.expired) {
    recordFailure('expiredReplay');
    sendJson(socket, {
      type: 'metrics-update',
      updatedServices: getAll(),
      timestamp: Date.now(),
      offset: replay.latestOffset,
      snapshot: true,
      replayFrom: payload.since
    });
    return;
  }

  sendJson(socket, replayMessage(replay.events, payload.since, replay.latestOffset));
}

function replayMessage(events: MetricEvent[], since: number, latestOffset: number): StreamUpdate {
  return {
    type: 'metrics-update',
    updatedServices: events.map(event => event.service),
    events,
    timestamp: events[events.length - 1]?.timestamp ?? Date.now(),
    offset: latestOffset,
    replayFrom: since
  };
}

function startBroadcasting(wss: WebSocketServer): NodeJS.Timeout {
  return setInterval(() => {
    const activeClients = [...wss.clients].filter(client => {
      const settings = clientChaos.get(client);
      return client.readyState === WebSocket.OPEN && !settings?.silent && !chaosConfig.wsSilent;
    });
    if (activeClients.length === 0) return;

    const update = updateMetrics();
    activeClients.forEach(client => {
      const settings = clientChaos.get(client);
      let updatedServices = update.updatedServices;
      if (settings?.shuffle || chaosConfig.shuffle) {
        const ids = updatedServices.map(service => service.id);
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        updatedServices = updatedServices.map((service, index) => ({ ...service, id: ids[index] }));
      }

      const message: StreamUpdate = {
        type: 'metrics-update',
        updatedServices,
        events: update.events,
        timestamp: update.timestamp,
        offset: update.events[update.events.length - 1]?.offset ?? getLatestOffset()
      };
      let json = JSON.stringify(message);
      const garbageEvery = Math.max(settings?.garbageEvery ?? 0, chaosConfig.garbageEvery);
      if (garbageEvery > 0 && settings) {
        settings.eventsSinceGarbage++;
        if (settings.eventsSinceGarbage >= garbageEvery) {
          settings.eventsSinceGarbage = 0;
          recordFailure('injectedMalformedWebSocketEvent');
          json = '{garbage:true,,,,}';
        }
      }

      const dropRate = Math.max(settings?.dropRate ?? 0, chaosConfig.wsDropRate);
      if (dropRate > 0 && Math.random() * 100 < dropRate) return;
      sendRaw(client, json);
      if (settings?.dupe || chaosConfig.dupe) sendRaw(client, json);
    });
  }, 500);
}

function startHeartbeat(
  wss: WebSocketServer,
  missedPongs: WeakMap<WebSocket, number>
): NodeJS.Timeout {
  return setInterval(() => {
    wss.clients.forEach(socket => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const missed = missedPongs.get(socket) ?? 0;
      if (missed >= 2) {
        console.log('[Heartbeat] Dead connection detected — terminating');
        recordFailure('missedWebSocketHeartbeat');
        socket.terminate();
        return;
      }
      missedPongs.set(socket, missed + 1);
      socket.ping(undefined, false, (error: Error) => {
        if (error) {
          recordFailure('websocketPingError');
          console.error('WebSocket ping failed:', error.message);
        }
      });
    });
  }, 5000);
}

function sendJson(socket: WebSocket, value: unknown): void {
  sendRaw(socket, JSON.stringify(value));
}

function sendRaw(socket: WebSocket, value: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(value, error => {
    if (error) {
      recordFailure('websocketSendError');
      console.error('WebSocket send failed:', error.message);
    }
  });
}
