import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const guardPath = fileURLToPath(new URL('../check-start.mjs', import.meta.url));

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-startup-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listen() {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: String(address.port), close: () => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())) };
}

async function freePort() {
  const lease = await listen();
  await lease.close();
  return lease.port;
}

function environment(directory: string, port: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: port, SESSIONDECK_DATA_DIR: join(directory, 'data') };
}

async function startupFixture(directory: string) {
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'bin'));
  await copyFile(new URL('../../start.sh', import.meta.url), join(directory, 'start.sh'));
  await copyFile(guardPath, join(directory, 'scripts', 'check-start.mjs'));
  // No dependencies exist. If the guard moves after npm ci, this leaves proof
  // and fails without installing anything or starting a real app.
  await writeFile(join(directory, 'bin', 'npm'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$STARTUP_NPM_LOG"\nexit 97\n', { mode: 0o755 });
  return { PATH: `${join(directory, 'bin')}:${process.env.PATH}`, STARTUP_NPM_LOG: join(directory, 'npm.log') };
}

test('startup refuses an occupied port before dependency installation, preflight or build', { timeout: 10_000 }, async t => {
  const directory = await temporary(t);
  const lease = await listen();
  t.after(lease.close);
  const fixture = await startupFixture(directory);
  await assert.rejects(execute('bash', [join(directory, 'start.sh')], {
    env: { ...environment(directory, lease.port), ...fixture }, timeout: 5000,
  }), (error: { code?: number; stderr?: string }) => error.code === 1 && /端口 .* 已被占用/.test(error.stderr ?? ''));
  await assert.rejects(stat(fixture.STARTUP_NPM_LOG), { code: 'ENOENT' });
  await assert.rejects(stat(join(directory, 'data')), { code: 'ENOENT' });
});

test('startup refuses a held data lease through an alias and leaves existing files and owner intact', { timeout: 10_000 }, async t => {
  const directory = await temporary(t);
  const fixture = await startupFixture(directory);
  const data = join(directory, 'data');
  await mkdir(data);
  const alias = join(directory, 'data-alias');
  await symlink(data, alias, 'dir');
  const lockPath = join(data, 'instance-lock.sqlite');
  const metadataPath = join(data, 'sessiondeck.sqlite');
  const metadata = 'Synthetic fixture: the startup guard must never open the metadata database.';
  await writeFile(metadataPath, metadata);
  const owner = new DatabaseSync(lockPath);
  owner.exec('BEGIN EXCLUSIVE;');
  const before = await stat(lockPath);
  try {
    await assert.rejects(execute('bash', [join(directory, 'start.sh')], {
      env: { ...environment(directory, await freePort()), ...fixture, SESSIONDECK_DATA_DIR: alias }, timeout: 5000,
    }), (error: { code?: number; stderr?: string }) => error.code === 1 && /数据目录已有 SessionDeck 实例/.test(error.stderr ?? ''));
    const after = await stat(lockPath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await readFile(metadataPath, 'utf8'), metadata);
    assert.equal(owner.isTransaction, true);
    await assert.rejects(stat(fixture.STARTUP_NPM_LOG), { code: 'ENOENT' });
  } finally { owner.close(); }
  await execute(process.execPath, [guardPath], { env: environment(directory, await freePort()), timeout: 5000 });
  assert.equal(await readFile(metadataPath, 'utf8'), metadata);
  assert.deepEqual((await readdir(data)).sort(), ['instance-lock.sqlite', 'sessiondeck.sqlite']);
});

test('startup accepts clean settings without creating files and honors HOST/PORT precedence', { timeout: 10_000 }, async t => {
  const directory = await temporary(t);
  const env = { ...environment(directory, await freePort()), SESSIONDECK_HOST: 'invalid.invalid', SESSIONDECK_PORT: 'invalid' };
  const result = await execute(process.execPath, [guardPath], { env, timeout: 5000 });
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(directory), []);
});

test('startup rejects invalid ports and blank hosts before creating data', { timeout: 10_000 }, async t => {
  const directory = await temporary(t);
  for (const port of ['0', '1023', '65536', '4317.5', 'invalid']) {
    await assert.rejects(execute(process.execPath, [guardPath], { env: environment(directory, port), timeout: 1000 }),
      (error: { code?: number; stderr?: string }) => error.code === 1 && /1024–65535/.test(error.stderr ?? ''));
  }
  await assert.rejects(execute(process.execPath, [guardPath], { env: { ...environment(directory, '4317'), HOST: '  ' }, timeout: 1000 }),
    (error: { code?: number; stderr?: string }) => error.code === 1 && /HOST 不能为空/.test(error.stderr ?? ''));
  assert.deepEqual(await readdir(directory), []);
});
