import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function allowedRequest(req: Pick<IncomingMessage, 'headers'>, port: number, allowAnyHost = false): boolean {
  const requestHost = req.headers.host;
  if (!requestHost) return false;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (allowAnyHost) {
    try {
      const url = new URL(`http://${requestHost}`);
      if (url.host !== requestHost || url.port !== String(port)) return false;
    } catch { return false; }
  } else if (!hosts.has(requestHost)) return false;
  const origin = req.headers.origin;
  const origins = allowAnyHost ? new Set([`http://${requestHost}`]) : new Set([...hosts].map(h => `http://${h}`));
  if (origin && !origins.has(origin)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

export function validToken(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * The remote listener is only reached through the tunnel and reverse proxy, so
 * it accepts the configured public host (plus its own loopback address for
 * debugging) and a matching Origin. Loopback trust never applies there.
 */
export function allowedRemoteRequest(req: Pick<IncomingMessage, 'headers' | 'method'>, publicUrl: string, localPort: number): boolean {
  const requestHost = req.headers.host;
  if (!requestHost) return false;
  const publicHost = publicUrl ? new URL(publicUrl).host : null;
  const hosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, ...(publicHost ? [publicHost] : [])]);
  if (!hosts.has(requestHost)) return false;
  const origin = req.headers.origin;
  const origins = new Set([`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`, ...(publicUrl ? [publicUrl] : [])]);
  if (origin && !origins.has(origin)) return false;
  // Browsers always send Origin on cross-origin mutations; require it remotely
  // so a missing header cannot stand in for a same-origin request.
  if (!origin && req.method && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}
