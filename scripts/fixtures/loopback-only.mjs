// Opt-in preload for native smoke checks. It is never loaded in normal use.
// Deny outbound network before DNS resolution, including telemetry and fallback
// providers, so an isolated fixture cannot accidentally contact a real service.
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function deny(host) {
  if (process.env.SESSIONDECK_NETWORK_AUDIT) appendFileSync(process.env.SESSIONDECK_NETWORK_AUDIT, `${String(host)}\n`, { mode: 0o600 });
  throw new Error(`Native smoke check blocked non-loopback network host: ${String(host)}`);
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0] : args;
  const options = input[0];
  const host = options && typeof options === 'object'
    ? options.host ?? options.hostname ?? 'localhost'
    : typeof input[1] === 'string' ? input[1] : 'localhost';
  if (!loopback.has(host)) deny(host);
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!loopback.has(url.hostname)) deny(url.hostname);
  return originalFetch.call(this, input, init);
};
syncBuiltinESMExports();
