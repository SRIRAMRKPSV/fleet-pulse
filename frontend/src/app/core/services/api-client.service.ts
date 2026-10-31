import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { apiUrl } from './api-config';

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable({ providedIn: 'root' })
export class ApiClientService {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly inFlightControllers = new Set<AbortController>();
  private logoutTriggered = false;

  request(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.auth.isAuthenticated()) this.logoutTriggered = false;
    const headers = new Headers(init.headers);
    const token = this.auth.accessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return this.requestUrl(apiUrl(path), { ...init, headers });
  }

  private async requestUrl(
    url: string,
    init: RequestInit,
    refreshed = false,
    attempt = 1
  ): Promise<Response> {
    const controller = new AbortController();
    this.inFlightControllers.add(controller);
    const externalSignal = init.signal;
    let timedOut = false;
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (externalSignal?.aborted) throw error;
      if (!this.auth.isAuthenticated() && this.logoutTriggered) throw error;
      if ((init.method ?? 'GET').toUpperCase() === 'GET' && attempt < MAX_ATTEMPTS) {
        await this.wait(this.backoff(attempt - 1));
        return this.requestUrl(url, init, refreshed, attempt + 1);
      }
      if (timedOut) {
        throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms.`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromCaller);
      this.inFlightControllers.delete(controller);
    }

    const method = (init.method ?? 'GET').toUpperCase();
    if (
      response.status === 401 &&
      !refreshed &&
      (method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE' ||
        (method === 'POST' && new Headers(init.headers).has('Idempotency-Key'))) &&
      this.auth.isAuthenticated()
    ) {
      try {
        const token = await this.auth.refreshToken();
        const nextHeaders = new Headers(init.headers);
        nextHeaders.set('Authorization', `Bearer ${token}`);
        return this.requestUrl(url, { ...init, headers: nextHeaders }, true);
      } catch (error) {
        console.error('Token refresh failed; ending the authenticated session:', error);
        this.abortProtectedRequests();
        if (!this.logoutTriggered) {
          this.logoutTriggered = true;
          this.auth.logout(this.router.url);
        }
        return response;
      }
    }

    if (method === 'GET' && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
      const retryAfter = response.status === 429 ? response.headers.get('Retry-After') : null;
      await this.wait(retryAfter ? this.retryAfterDelay(retryAfter) : this.backoff(attempt - 1));
      return this.requestUrl(url, init, refreshed, attempt + 1);
    }

    return response;
  }

  private backoff(retryCount: number): number {
    const exponential = Math.min(30_000, 500 * 2 ** retryCount);
    return Math.min(30_000, Math.round(exponential * (0.5 + Math.random())));
  }

  private retryAfterDelay(value: string): number {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? this.backoff(0) : Math.max(0, date - Date.now());
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  private abortProtectedRequests(): void {
    for (const controller of this.inFlightControllers) controller.abort();
    this.inFlightControllers.clear();
  }
}
