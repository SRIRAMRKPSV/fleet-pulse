import { Router, Request, Response } from 'express';
import {
  getAll,
  getEventsAfter,
  getLatestOffset,
  getServiceSequences,
  updateMetrics
} from '../services-store';
import { StreamUpdate } from '../models';
import { recordFailure } from '../failure-counters';

const router = Router();

// ============================================================
// SSE - Server-Sent Events (Fallback transport)
// GET /api/events
//
// SSE is a one-way stream: server → client.
// The client connects once and keeps the connection open.
// Server pushes updates every 500ms.
//
// Used as fallback when WebSocket is not available.
// ============================================================
router.get('/', (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'];
  const queryOffset = req.query['since'];
  const rawOffset = lastEventId ?? queryOffset;
  const requestedOffset = rawOffset === undefined ? null : Number(rawOffset);
  if (rawOffset !== undefined && (
    typeof rawOffset !== 'string'
    || !/^\d+$/.test(rawOffset)
    || !Number.isSafeInteger(requestedOffset)
  )) {
    recordFailure('invalidReplayOffset');
    res.status(400).json({ success: false, message: 'SSE offset must be a non-negative integer' });
    return;
  }

  const replay = requestedOffset === null ? null : getEventsAfter(requestedOffset as number);
  if (replay && requestedOffset !== null && requestedOffset > replay.latestOffset) {
    recordFailure('invalidReplayOffset');
    res.status(400).json({
      success: false,
      message: 'SSE offset cannot be greater than the latest stream offset',
      latestOffset: replay.latestOffset
    });
    return;
  }

  if (replay?.expired) {
    recordFailure('expiredReplay');
  }

  // Set the required SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders(); // Send headers immediately

  console.log('SSE client connected');

  let timer: NodeJS.Timeout | undefined;
  let disconnected = false;
  const send = (message: StreamUpdate): void => {
    if (disconnected || res.destroyed) return;
    const offset = message.offset ?? getLatestOffset();
    if (!res.write(`id: ${offset}\nevent: metrics-update\ndata: ${JSON.stringify(message)}\n\n`)) {
      disconnected = true;
      if (timer) clearInterval(timer);
      res.end();
    }
  };

  if (!replay || replay.expired) {
    send({
      type: 'metrics-update',
      updatedServices: getAll(),
      timestamp: Date.now(),
      offset: getLatestOffset(),
      snapshot: true,
      sequences: getServiceSequences()
    });
  } else {
    for (const event of replay.events) {
      send({
        type: 'metrics-update',
        updatedServices: [event.service],
        events: [event],
        timestamp: event.timestamp,
        offset: event.offset,
        replayFrom: requestedOffset ?? 0
      });
    }
  }

  timer = setInterval(() => {
    const update = updateMetrics();

    const message: StreamUpdate = {
      type: 'metrics-update',
      updatedServices: update.updatedServices,
      events: update.events,
      timestamp: update.timestamp,
      offset: update.events[update.events.length - 1]?.offset ?? getLatestOffset()
    };

    send(message);
  }, 500);

  // When client disconnects, clear the timer
  res.on('close', () => {
    disconnected = true;
    if (timer) clearInterval(timer);
    console.log('SSE client disconnected');
  });
});

export default router;
