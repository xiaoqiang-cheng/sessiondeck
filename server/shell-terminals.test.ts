import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ShellTerminals } from './shell-terminals.ts';

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (check()) return; await delay(20); }
  throw new Error(message);
}

test('independent shells accept commands, resize, retain output and report natural exit', { timeout: 15_000, skip: process.platform === 'win32' }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'sessiondeck-shell-'));
  const shells = new ShellTerminals('/bin/sh');
  t.after(async () => { await shells.close(); await rm(cwd, { recursive: true, force: true }); });
  const first = shells.create(cwd), second = shells.create(cwd);
  assert.notEqual(first.id, second.id);
  assert.equal(first.cwd, cwd);
  assert.equal(shells.list().length, 2);
  let output = '', other = '';
  shells.on('data', (id: string, data: string) => { if (id === first.id) output += data; else other += data; });
  shells.input(first.id, "printf 'FIRST_%s\\n' 'ONLY'\r");
  await until(() => output.includes('FIRST_ONLY'), 'Interactive shell did not execute a command');
  assert.equal(other.includes('FIRST_ONLY'), false, 'Each shell must own an independent PTY');
  shells.input(first.id, "printf 'CWD='; pwd\r");
  await until(() => output.includes(`CWD=${cwd}`), 'Shell did not start in its selected workspace');
  shells.resize(first.id, 113, 37);
  shells.input(first.id, 'stty size\r');
  await until(() => /(?:\r?\n)37 113\r?\n/.test(output), 'PTY resize did not reach the shell');
  await until(() => shells.buffer(first.id).includes('FIRST_ONLY'), 'Terminal replay did not retain shell output');
  shells.input(first.id, 'exit 7\r');
  await until(() => shells.get(first.id)?.running === false, 'Natural shell exit was not reported');
  assert.equal(shells.get(first.id)?.exitCode, 7);
  assert.equal(shells.get(second.id)?.running, true);
  assert.throws(() => shells.input(first.id, 'echo gone\r'), /退出/);
  await shells.remove(first.id);
  assert.equal(shells.get(first.id), undefined);
});

test('closing a shell ends its foreground command and prevents further input', { timeout: 10_000, skip: process.platform === 'win32' }, async t => {
  const shells = new ShellTerminals('/bin/sh');
  t.after(() => shells.close());
  const terminal = shells.create(process.cwd());
  let output = '';
  shells.on('data', (_id: string, data: string) => { output += data; });
  shells.input(terminal.id, "sleep 60 & printf 'CHILD_%s\\n' \"$!\"; wait\r");
  await until(() => /CHILD_\d+/.test(output), 'Long-running child command did not start');
  const pid = Number(output.match(/CHILD_(\d+)/)![1]);
  const alive = () => {
    try {
      if (process.platform === 'linux') return !/^[ZX]$/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[0]!);
      process.kill(pid, 0); return true;
    } catch { return false; }
  };
  assert.equal(alive(), true);
  await shells.remove(terminal.id);
  await until(() => !alive(), 'Closing the shell left its child command running');
  assert.deepEqual(shells.list(), []);
  assert.throws(() => shells.input(terminal.id, 'pwd\r'), /退出/);
  await shells.close();
  assert.throws(() => shells.create(process.cwd()), /关闭/);
});
