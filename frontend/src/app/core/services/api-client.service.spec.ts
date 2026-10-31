import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ApiClientService } from './api-client.service';
import { AuthService } from './auth.service';

describe('ApiClientService', () => {
  let api: ApiClientService;
  const mockRouter = {
    url: '/services/svc-12',
    navigate: vi.fn(),
    navigateByUrl: vi.fn()
  };

  function response(status: number, body: unknown = {}, headers = new Headers()): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      json: async () => body
    } as Response;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn());
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: mockRouter }]
    });
    api = TestBed.inject(ApiClientService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockRouter.navigate.mockClear();
  });

  it('retries eligible GET server errors and returns the successful response', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));

    const pending = api.request('services');
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry other 4xx responses', async () => {
    vi.mocked(fetch).mockResolvedValue(response(400));

    const result = await api.request('services');

    expect(result.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After for 429 responses', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(429, {}, new Headers({ 'Retry-After': '1' })))
      .mockResolvedValueOnce(response(200));

    const pending = api.request('services');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('limits GET network failures to three total attempts', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network failure'));
    const pending = api.request('services');
    const outcome = pending.then(
      () => null,
      error => error
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBeInstanceOf(Error);
    expect((await outcome as Error).message).toBe('Network failure');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('applies the ten-second timeout and limits timed-out requests to three attempts', async () => {
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = api.request('services');
    const outcome = pending.then(
      () => null,
      error => error
    );

    await vi.advanceTimersByTimeAsync(32_000);
    const error = await outcome;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('timed out after 10000ms');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not blindly retry non-idempotent POST requests', async () => {
    vi.mocked(fetch).mockResolvedValue(response(503));

    const result = await api.request('rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rule' })
    });

    expect(result.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes once and retries the original request after a 401', async () => {
    const auth = TestBed.inject(AuthService);
    auth.currentUser.set({ id: 'user-1', email: 'user@example.test', role: 'operator' });
    auth.accessToken.set('expired-access-token');
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, { data: { accessToken: 'new-access-token' } }))
      .mockResolvedValueOnce(response(200));

    const result = await api.request('services');

    expect(result.status).toBe(200);
    expect(auth.accessToken()).toBe('new-access-token');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('shares one refresh across ten concurrent expired requests and replays all of them', async () => {
    const auth = TestBed.inject(AuthService);
    auth.currentUser.set({ id: 'user-1', email: 'user@example.test', role: 'operator' });
    auth.accessToken.set('expired-access-token');
    auth.refreshTokenValue.set('refresh-token');
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return response(200, {
          success: true,
          data: { accessToken: 'new-access-token', refreshToken: 'new-refresh-token' }
        });
      }
      const headers = new Headers(init?.headers);
      return headers.get('Authorization') === 'Bearer expired-access-token'
        ? response(401)
        : response(200);
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_value, index) => api.request(`services/${index}`))
    );

    expect(results.every(result => result.status === 200)).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh')))
      .toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(21);
    expect(auth.refreshTokenValue()).toBe('new-refresh-token');
  });

  it('ends the session and preserves the current route when refresh fails', async () => {
    const auth = TestBed.inject(AuthService);
    auth.currentUser.set({ id: 'user-1', email: 'user@example.test', role: 'operator' });
    auth.accessToken.set('expired-access-token');
    auth.refreshTokenValue.set('refresh-token');
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(401, { success: false, message: 'Expired refresh token' }));

    const result = await api.request('services');

    expect(result.status).toBe(401);
    expect(auth.isAuthenticated()).toBe(false);
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/services/svc-12' }
    });
  });
});
