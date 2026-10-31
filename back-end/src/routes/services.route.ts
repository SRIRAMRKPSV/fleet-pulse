import { Router, Request, Response } from 'express';
import * as ServicesStore from '../services-store';
import { recordFailure } from '../failure-counters';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const all = ServicesStore.getAll();
  res.json({ success: true, data: all, count: all.length });
});

router.get('/snapshot', (_req: Request, res: Response) => {
  const all = ServicesStore.getAll();
  res.json({
    success: true,
    data: all,
    count: all.length,
    snapshotAt: Date.now(),
    offset: ServicesStore.getLatestOffset(),
    sequences: ServicesStore.getServiceSequences()
  });
});

router.get('/replay', (req: Request, res: Response) => {
  const rawOffset = req.query['since'];
  const since = rawOffset === undefined ? 0 : Number(rawOffset);
  if (typeof rawOffset !== 'undefined' && (
    typeof rawOffset !== 'string'
    || !/^\d+$/.test(rawOffset)
    || !Number.isSafeInteger(since)
  )) {
    recordFailure('invalidReplayOffset');
    res.status(400).json({ success: false, message: 'since must be a non-negative integer' });
    return;
  }

  const replay = ServicesStore.getEventsAfter(since);
  if (since > replay.latestOffset) {
    recordFailure('invalidReplayOffset');
    res.status(400).json({
      success: false,
      message: 'since cannot be greater than the latest stream offset',
      latestOffset: replay.latestOffset
    });
    return;
  }

  if (replay.expired) {
    recordFailure('expiredReplay');
    const snapshotAt = Date.now();
    const data = ServicesStore.getAll();
    res.status(410).json({
      success: false,
      code: 'REPLAY_HISTORY_EXPIRED',
      message: 'Replay history is no longer available; use the included full snapshot',
      requestedOffset: since,
      oldestOffset: replay.oldestOffset,
      latestOffset: replay.latestOffset,
      snapshot: {
        data,
        count: data.length,
        snapshotAt,
        offset: replay.latestOffset,
        sequences: ServicesStore.getServiceSequences()
      },
      data,
      count: data.length,
      snapshotAt
    });
    return;
  }

  const all = ServicesStore.getAll();
  res.json({
    success: true,
    data: all,
    count: all.length,
    events: replay.events,
    replayCount: replay.events.length,
    replayFrom: since,
    latestOffset: replay.latestOffset,
    oldestOffset: replay.oldestOffset
  });
});

router.get('/:id/history', (req: Request, res: Response) => {
  const history = ServicesStore.getHistoryForService(req.params['id']);
  if (!history) {
    res.status(404).json({ success: false, message: 'Service not found' });
    return;
  }

  res.json({ success: true, data: history });
});

router.get('/:id', (req: Request, res: Response) => {
  const service = ServicesStore.getById(req.params['id']);
  if (!service) {
    res.status(404).json({ success: false, message: 'Service not found' });
    return;
  }
  res.json({ success: true, data: service });
});

export default router;
