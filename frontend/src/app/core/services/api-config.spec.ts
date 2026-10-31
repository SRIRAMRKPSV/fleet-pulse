import { sseUrl } from './api-config';

describe('sseUrl', () => {
  it('uses the configured SSE endpoint without an initial replay cursor', () => {
    const url = new URL(sseUrl());

    expect(url.pathname).toBe('/api/events');
    expect(url.searchParams.has('since')).toBe(false);
  });

  it('includes the last applied offset when reconnecting for replay', () => {
    const url = new URL(sseUrl(42));

    expect(url.pathname).toBe('/api/events');
    expect(url.searchParams.get('since')).toBe('42');
  });
});
