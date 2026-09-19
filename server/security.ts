import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function allowedRequest(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!req.headers.host || !hosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !new Set([...hosts].map(h => `http://${h}`)).has(origin)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

export function validToken(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
