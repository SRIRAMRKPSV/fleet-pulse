import { environment } from '../../../environments/environment';

const API_BASE_URL = environment.apiBaseUrl.replace(/\/+$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE_URL}/${path.replace(/^\/+/, '')}`;
}

export function webSocketUrl(): string {
  const url = new URL(environment.webSocketUrl, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function sseUrl(since?: number): string {
  const url = new URL(environment.sseUrl, window.location.origin);
  if (since !== undefined) url.searchParams.set('since', String(since));
  return url.toString();
}

export function healthUrl(): string {
  return new URL(environment.healthUrl, window.location.origin).toString();
}

export function authLoginUrl(): string {
  return apiUrl('auth/login');
}

export function authRefreshUrl(): string {
  return apiUrl('auth/refresh');
}

export function authHeaders(
  token: string | null,
  headers: Record<string, string> = {}
): Record<string, string> {
  return token ? { ...headers, Authorization: 'Bearer ' + token } : headers;
}
