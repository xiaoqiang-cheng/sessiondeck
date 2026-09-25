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
