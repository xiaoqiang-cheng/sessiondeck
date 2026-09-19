import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native hook forwards only lifecycle fields, keeping conversation and tool text out of monitoring', async t => {
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    received.push(JSON.parse(data)); response.end('{}');
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise<void>(accept => server.close(() => accept())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  for (const source of ['claude', 'codex']) {
    const payload = source === 'claude'
      ? { session_id: id, hook_event_name: 'PermissionRequest', tool_input: { content: 'private tool content' }, prompt: 'private user content' }
      : { 'thread-id': id, type: 'agent-turn-complete', 'last-assistant-message': 'private reply', 'input-messages': ['private prompt'] };
    const args = [fileURLToPath(new URL('./native-hook.cjs', import.meta.url)), `http://127.0.0.1:${address.port}/hook`, 'fixture-token', source];
    if (source === 'codex') args.push(JSON.stringify(payload));
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data; });
    child.stdin.end(source === 'claude' ? JSON.stringify(payload) : undefined);
    const exitCode = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
    assert.equal(exitCode, 0, error);
  }
  assert.deepEqual(received, [
    { source: 'claude', payload: { session_id: id, hook_event_name: 'PermissionRequest' } },
    { source: 'codex', payload: { 'thread-id': id, type: 'agent-turn-complete' } },
  ]);
});
