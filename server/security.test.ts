import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingHttpHeaders } from 'node:http';
import { allowedRequest, validToken } from './security.ts';

const port = 4317;
const allowed = (headers: IncomingHttpHeaders) => allowedRequest({ headers }, port);

test('same-origin requests to explicit loopback hosts pass, including direct local navigation', () => {
  for (const host of ['127.0.0.1:4317', 'localhost:4317', '[::1]:4317']) {
    assert.equal(allowed({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }), true);
    assert.equal(allowed({ host }), true);
    assert.equal(allowed({ host, 'sec-fetch-site': 'none' }), true);
  }
});

test('wildcard binding accepts any host on the configured port', () => {
  for (const host of ['192.168.1.20:4317', '10.0.0.2:4317', 'sessiondeck.local:4317', '[fd00::20]:4317']) {
    assert.equal(allowedRequest({ headers: { host, origin: `http://${host}` } }, port, true), true);
    assert.equal(allowedRequest({ headers: { host } }, port, true), true);
  }
  assert.equal(allowedRequest({ headers: { host: '192.168.1.21:9999', origin: 'http://192.168.1.21:9999' } }, port, true), false);
});

test('wildcard binding retains same-origin checks and rejects malformed hosts', () => {
  const host = '192.168.1.20:4317';
  for (const origin of ['http://another.example:4317', 'https://192.168.1.20:4317', 'null']) {
    assert.equal(allowedRequest({ headers: { host, origin } }, port, true), false);
  }
  assert.equal(allowedRequest({ headers: { host, 'sec-fetch-site': 'cross-site' } }, port, true), false);
  for (const invalidHost of [undefined, 'user@sessiondeck.local:4317', 'bad host:4317', 'sessiondeck.local/path:4317']) {
    assert.equal(allowedRequest({ headers: { host: invalidHost } }, port, true), false);
  }
});

test('DNS rebinding and host suffix tricks are rejected even with a claimed local origin', () => {
  for (const host of [
    undefined, 'attacker.example:4317', '127.0.0.1.attacker.example:4317',
    'localhost.attacker.example:4317', 'localhost:9999', '127.0.0.1',
    '127.0.0.1:4317@attacker.example', 'localhost:4317, attacker.example',
  ]) {
    assert.equal(allowed({ host, origin: 'http://127.0.0.1:4317' }), false, `Host ${host}`);
  }
});

test('cross-origin requests and opaque origins are rejected on an otherwise valid host', () => {
  for (const origin of [
    'https://attacker.example', 'http://127.0.0.1:9999', 'http://localhost:9999',
    'https://localhost:4317', 'http://localhost:4317.attacker.example', 'null',
    'http://127.0.0.1:4317/', 'http://attacker.example@127.0.0.1:4317',
  ]) {
    assert.equal(allowed({ host: '127.0.0.1:4317', origin }), false, `Origin ${origin}`);
  }
});

test('cross-site fetch metadata blocks requests even when Origin is absent or claims loopback', () => {
  assert.equal(allowed({ host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(allowed({
    host: 'localhost:4317', origin: 'http://localhost:4317', 'sec-fetch-site': 'cross-site',
  }), false);
});

test('token validation compares equal-length bytes and safely rejects malformed and unequal lengths', () => {
  const expected = '1234567890abcdef1234567890abcdef';
  assert.equal(validToken(expected, expected), true);
  for (const value of [
    null, undefined, 123, {}, [expected], '', `${expected}0`, expected.slice(1),
    '0234567890abcdef1234567890abcdef',
  ]) {
    assert.equal(validToken(value, expected), false);
  }
  // These strings have different JS lengths but identical byte lengths; neither may throw.
  assert.equal(validToken('é', 'ab'), false);
  assert.equal(validToken('é', 'é'), true);
  assert.equal(validToken('𝌆', 'abcd'), false);
});
