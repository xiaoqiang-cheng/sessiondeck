import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Store } from './store.ts';
import { terminalPathToken, Terminals } from './terminal.ts';

test('terminal image path tokens preserve one native composer token', () => {
  assert.equal(terminalPathToken('/tmp/session deck/a$b\'s.png'), "'/tmp/session deck/a$b'\\''s.png'");
});

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  throw new Error(description);
}

test('group staging strips embedded terminal controls and does not send a submit character', { timeout: 8000 }, async t => {
  const store = new Store(':memory:');
  const terminals = new Terminals();
  t.after(async () => { try { await terminals.close(); } finally { store.close(); } });
  const session = store.addSession({ backend: 'codex', title: 'control stripping fixture', cwd: process.cwd() });
  let output = '';
  terminals.on('data', (_id, data: string) => { output += data; });
  terminals.start(session, {
    file: process.execPath,
    args: ['-e', `process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let text='';process.stdout.write('READY');process.stdin.on('data',data=>{text+=data;if(text.endsWith('\\x1b[201~'))process.stdout.write('\\r\\nCAPTURE:'+Buffer.from(text).toString('base64')+'\\r\\n');});`],
  });
  await until(() => output.includes('READY'), 'Raw PTY fixture did not start');
  terminals.stage(session.id, 'task\r\nnext\tfield\u0003\u0000\u001b[31m');
  await until(() => /CAPTURE:([A-Za-z0-9+/=]+)/.test(output), 'Staged text was not observed');
  const encoded = output.match(/CAPTURE:([A-Za-z0-9+/=]+)/)![1]!;
  const received = Buffer.from(encoded, 'base64').toString();
  assert.ok(received.startsWith('\u001b[200~'));
  assert.ok(received.endsWith('\u001b[201~'));
  const body = received.slice(6, -6);
  assert.equal(body, 'task  nextfield[31m');
  assert.doesNotMatch(body, /[\x00-\x1f\x7f]/);
  assert.equal(terminals.has(session.id), true, 'Control-C from task text must not stop the process');
});

test('PTY generations reject a stale staged image after replacement', { timeout: 8000 }, async t => {
  const store = new Store(':memory:');
  const terminals = new Terminals();
  t.after(async () => { try { await terminals.close(); } finally { store.close(); } });
  const session = store.addSession({ backend: 'codex', title: 'generation fixture', cwd: process.cwd() });
  terminals.start(session, { file: process.execPath, args: ['-e', `process.stdout.write('READY');setInterval(()=>{},1000);`] });
  await until(() => terminals.buffer(session.id).includes('READY'), 'Generation fixture did not start');
  const first = terminals.generation(session.id);
  assert.match(first ?? '', /^[a-f0-9-]{36}$/);
  await terminals.stop(session.id);
  terminals.start(session, { file: process.execPath, args: ['-e', `process.stdout.write('READY2');setInterval(()=>{},1000);`] });
  await until(() => terminals.buffer(session.id).includes('READY2'), 'Replacement fixture did not start');
  const second = terminals.generation(session.id);
  assert.match(second ?? '', /^[a-f0-9-]{36}$/);
  assert.notEqual(second, first);
  assert.throws(() => terminals.stagePath(session.id, '/tmp/image.png', first!), /重启/);
  assert.doesNotThrow(() => terminals.stagePath(session.id, '/tmp/image.png', second!));
});

test('late exit of a stopped PTY cannot stop or replace a newly started terminal for the same contact', { timeout: 8000 }, async t => {
  const store = new Store(':memory:');
  const terminals = new Terminals();
  t.after(async () => { try { await terminals.close(); } finally { store.close(); } });
  const session = store.addSession({ backend: 'claude', title: 'restart fixture', cwd: process.cwd() });
  const exits: number[] = [];
  terminals.on('exit', (_id: string, code: number) => exits.push(code));
  terminals.start(session, {
    file: process.execPath,
    args: ['-e', `const finish=()=>setTimeout(()=>process.exit(0),150);process.on('SIGHUP',finish);process.on('SIGTERM',finish);process.stdout.write('OLD_READY');setInterval(()=>{},1000);`],
  });
  await until(() => terminals.buffer(session.id).includes('OLD_READY'), 'First terminal did not start');
  const stopped = terminals.stop(session.id);
  assert.equal(terminals.has(session.id), true, 'keep ownership until cleanup finishes');
  assert.throws(() => terminals.start(session, { file: process.execPath, args: ['-e', 'process.exit(0)'] }), /正在停止/);
  await stopped;
  terminals.start(session, {
    file: process.execPath,
    args: ['-e', `process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdout.write('NEW_READY');process.stdin.on('data',d=>process.stdout.write('NEW_RECEIVED:'+d));`],
  });
  await until(() => terminals.buffer(session.id).includes('NEW_READY'), 'Replacement terminal did not start');
  // Let the old process's intentionally delayed exit notification arrive after the replacement starts.
  await delay(250);
  assert.equal(exits.length, 1, 'Only the explicit stop should emit an exit');
  assert.equal(terminals.has(session.id), true);
  terminals.input(session.id, 'still-live');
  await until(() => terminals.buffer(session.id).includes('NEW_RECEIVED:still-live'), 'Replacement stopped accepting input');
  assert.equal(terminals.buffer(session.id).includes('OLD_READY'), false);
});

test('forced cleanup of a stopped stubborn PTY never targets its immediate replacement', { timeout: 8000 }, async t => {
  const store = new Store(':memory:');
  const terminals = new Terminals();
  t.after(async () => { await terminals.close(); store.close(); });
  const session = store.addSession({ backend: 'claude', title: 'stubborn replacement fixture', cwd: process.cwd() });
  terminals.start(session, {
    file: process.execPath,
    args: ['-e', `process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});process.stdout.write('OLD_READY');setInterval(()=>{},1000);`],
  });
  await until(() => terminals.buffer(session.id).includes('OLD_READY'), 'Stubborn terminal did not start');
  const stopped = terminals.stop(session.id);
  assert.equal(terminals.stop(session.id), stopped, 'concurrent stops join the cleanup');
  assert.throws(() => terminals.start(session, { file: process.execPath, args: ['-e', 'process.exit(0)'] }), /正在停止/);
  await stopped;
  terminals.start(session, {
    file: process.execPath,
    args: ['-e', `process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdout.write('NEW_READY');process.stdin.on('data',data=>process.stdout.write('NEW_RECEIVED:'+data));`],
  });
  await until(() => terminals.buffer(session.id).includes('NEW_READY'), 'Replacement terminal did not start');
  await delay(1200);
  assert.equal(terminals.has(session.id), true);
  terminals.input(session.id, 'after-escalation');
  await until(() => terminals.buffer(session.id).includes('NEW_RECEIVED:after-escalation'), 'Old process escalation damaged the replacement');
  await terminals.close();
  assert.throws(() => terminals.start(session, { file: process.execPath, args: ['-e', 'process.exit(0)'] }), /正在关闭/);
});
