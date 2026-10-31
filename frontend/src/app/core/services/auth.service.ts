import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { User } from '../models/auth.model';
import { authLoginUrl, authRefreshUrl } from './api-config';

interface AuthResponse {
  success?: boolean;
  message?: string;
  id?: unknown;
  token?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
  data?: {
    id?: unknown;
    email?: unknown;
    role?: unknown;
    token?: unknown;
    accessToken?: unknown;
    refreshToken?: unknown;
  };
}

function getAccessToken(body: AuthResponse | null): string | null {
  const token = body?.data?.accessToken ?? body?.data?.token ?? body?.accessToken ?? body?.token;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly router = inject(Router);
  private refreshInFlight: Promise<string> | null = null;

  // Access token stored in memory only (Requirement A2)
  accessToken = signal<string | null>(null);
  refreshTokenValue = signal<string | null>(null);

  // Currently logged-in user (null until logged in via Backend API)
  currentUser = signal<User | null>(null);

  // Computed helpers
  isAuthenticated = computed(() => this.currentUser() !== null && this.accessToken() !== null);
  isOperator      = computed(() => this.currentUser()?.role === 'operator');
  isViewer        = computed(() => this.currentUser()?.role === 'viewer');

  // Error message shown on login form
  loginError = signal<string | null>(null);
  isLoading  = signal<boolean>(false);

  // ============================================================
  // login()
  // Calls POST /api/auth/login on the backend.
  // Sets currentUser + accessToken on success.
  // ============================================================
  async login(email: string, pass: string): Promise<boolean> {
    this.loginError.set(null);
    this.isLoading.set(true);

    try {
      const response = await fetchWithTimeout(authLoginUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass })
      });

      let body: AuthResponse | null;
      try {
        body = await response.json() as AuthResponse;
      } catch {
        if (response.ok) throw new Error('The login response was not valid JSON.');
        body = null;
      }

      if (!response.ok) {
        const fallback = response.status === 401 || response.status === 403
          ? 'Invalid email or password'
          : `Login failed (${response.status}).`;
        this.loginError.set(body?.message || fallback);
        return false;
      }

      if (!body?.success) {
        this.loginError.set(body?.message || 'The login response was unsuccessful.');
        return false;
      }

      const userData = body?.data;
      const accessToken = getAccessToken(body);
      const refreshToken = userData?.refreshToken;
      const role = userData?.role;
      if (
        !userData ||
        typeof userData.email !== 'string' ||
        !accessToken ||
        typeof refreshToken !== 'string' ||
        (role !== 'operator' && role !== 'viewer')
      ) {
        this.loginError.set('The login response was missing valid user or token data.');
        return false;
      }

      this.currentUser.set({
        id: typeof userData.id === 'string' ? userData.id : userData.email,
        email: userData.email,
        role
      });
      this.accessToken.set(accessToken);
      this.refreshTokenValue.set(refreshToken);
      return true;

    } catch (error) {
      this.loginError.set(
        error instanceof Error ? `Unable to connect to the backend: ${error.message}` : 'Unable to connect to the backend.'
      );
      return false;
    } finally {
      this.isLoading.set(false);
    }
  }

  // ============================================================
  // logout() - clears user and goes back to login page
  // ============================================================
  logout(returnUrl?: string): void {
    this.currentUser.set(null);
    this.accessToken.set(null);
    this.refreshTokenValue.set(null);
    this.loginError.set(null);

    if (returnUrl) {
      this.router.navigate(['/login'], { queryParams: { returnUrl } });
    } else {
      this.router.navigate(['/login']);
    }
  }

  // ============================================================
  // Calls the backend refresh endpoint (Requirement A4).
  refreshToken(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performTokenRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performTokenRefresh(): Promise<string> {
    try {
      const response = await fetchWithTimeout(authRefreshUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshTokenValue() })
      });
      let body: AuthResponse | null;
      try {
        body = await response.json() as AuthResponse;
      } catch {
        if (response.ok) throw new Error('The refresh response was not valid JSON.');
        body = null;
      }

      if (!response.ok || body?.success === false) {
        throw new Error(body?.message || `Token refresh failed (${response.status}).`);
      }

      const newToken = getAccessToken(body);
      if (!newToken) {
        throw new Error('The refresh response did not include an access token.');
      }

      this.accessToken.set(newToken);
      if (typeof body?.data?.refreshToken === 'string' && body.data.refreshToken.length > 0) {
        this.refreshTokenValue.set(body.data.refreshToken);
      }
      return newToken;
    } catch (error) {
      this.currentUser.set(null);
      this.accessToken.set(null);
      this.refreshTokenValue.set(null);
      if (error instanceof Error) throw error;
      throw new Error('Token refresh failed.', { cause: error });
    }
  }
}
