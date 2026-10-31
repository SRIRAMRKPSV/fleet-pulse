import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { Router } from '@angular/router';
import { authLoginUrl, authRefreshUrl } from './api-config';

describe('AuthService', () => {
  let service: AuthService;
  let mockRouter: {
    navigate: ReturnType<typeof vi.fn>;
    navigateByUrl: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    mockRouter = {
      navigate: vi.fn(),
      navigateByUrl: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: Router, useValue: mockRouter }
      ]
    });

    service = TestBed.inject(AuthService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      json: async () => body
    } as Response;
  }

  it('should initialize unauthenticated (clean state, no sample data)', () => {
    expect(service.isAuthenticated()).toBe(false);
    expect(service.currentUser()).toBeNull();
  });

  it('should reject invalid password', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ success: false, message: 'Invalid email or password' }, false, 401)
    );
    const success = await service.login('operator@pulse.dev', 'wrongpassword');
    expect(success).toBe(false);
    expect(service.loginError()).toBeTruthy();
  });

  it('should login operator with pulse123', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({
      success: true,
      data: {
        email: 'operator@pulse.dev', role: 'operator',
        accessToken: 'server-token', refreshToken: 'server-refresh-token'
      }
    }));
    const success = await service.login('operator@pulse.dev', 'pulse123');
    expect(success).toBe(true);
    expect(service.isOperator()).toBe(true);
    expect(service.accessToken()).toBeTruthy();
    expect(service.accessToken()).toBe('server-token');
    expect(fetch).toHaveBeenCalledWith(authLoginUrl(), expect.objectContaining({ method: 'POST' }));
  });

  it('should login viewer with pulse123 and set viewer role', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({
      success: true,
      data: {
        email: 'viewer@pulse.dev', role: 'viewer',
        token: 'viewer-server-token', refreshToken: 'viewer-refresh-token'
      }
    }));
    const success = await service.login('viewer@pulse.dev', 'pulse123');
    expect(success).toBe(true);
    expect(service.isViewer()).toBe(true);
  });

  it('should refresh token', async () => {
    service.accessToken.set('old-server-token');
    service.refreshTokenValue.set('refresh-token');
    vi.mocked(fetch).mockResolvedValue(mockResponse({
      success: true,
      data: {
        accessToken: 'refreshed-server-token',
        refreshToken: 'rotated-refresh-token'
      }
    }));
    const token = await service.refreshToken();
    expect(token).toBe('refreshed-server-token');
    expect(service.accessToken()).toBe(token);
    expect(service.refreshTokenValue()).toBe('rotated-refresh-token');
    expect(fetch).toHaveBeenCalledWith(authRefreshUrl(), expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'refresh-token' })
    }));
  });

  it('shares one refresh request between concurrent callers', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({
      success: true,
      data: { accessToken: 'shared-refreshed-token' }
    }));

    service.refreshTokenValue.set('refresh-token');
    const first = service.refreshToken();
    const second = service.refreshToken();
    expect(first).toBe(second);
    await expect(first).resolves.toBe('shared-refreshed-token');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.refreshTokenValue()).toBe('refresh-token');
  });

  it('should not authenticate with local credentials when the backend is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));
    const success = await service.login('operator@pulse.dev', 'pulse123');
    expect(success).toBe(false);
    expect(service.isAuthenticated()).toBe(false);
    expect(service.loginError()).toContain('Unable to connect');
  });

  it('should logout cleanly', () => {
    service.logout('/services/svc-0001');
    expect(service.isAuthenticated()).toBe(false);
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/services/svc-0001' }
    });
  });
});
