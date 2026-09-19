import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

test('native fixture preload permits loopback and blocks fetch, TCP, HTTP and TLS before DNS', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sessiondeck-smoke-network-'));
  const audit = join(dir, 'audit.txt');
  const server = createServer((_request, response) => response.end('loopback-ok'));
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => { await new Promise<void>(accept => server.close(() => accept())); await rm(dir, { recursive: true, force: true }); });
  const source = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import http from 'node:http';
    import https from 'node:https';
    const blocked = /blocked non-loopback/;
    const response = await fetch('http://127.0.0.1:${address.port}');
    assert.equal(await response.text(), 'loopback-ok');
    assert.throws(() => fetch('https://example.invalid/model'), blocked);
    assert.throws(() => net.connect({ host: 'example.invalid', port: 443 }), blocked);
    assert.throws(() => net.connect(443, 'example.invalid'), blocked);
    for (const client of [http, https]) {
      assert.throws(() => client.get({ hostname: 'example.invalid', path: '/' }), blocked);
    }
    console.log('guard-passed');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', new URL('./loopback-only.mjs', import.meta.url).href, '--input-type=module', '-e', source], { timeout: 5000, env: { SESSIONDECK_NETWORK_AUDIT: audit } });
  assert.equal(stdout.trim(), 'guard-passed');
  assert.deepEqual((await readFile(audit, 'utf8')).trim().split('\n'), Array(5).fill('example.invalid'));
});
