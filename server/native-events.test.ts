import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { nativeHookPatch } from './native-events.ts';
import type { Session } from '../shared/types.ts';

const session = (patch: Partial<Session> = {}) => ({ backend: 'claude', nativeSessionId: null, forkPending: false, ...patch }) as Session;

test('native hooks require a valid backend identity and a recognized event', () => {
  const id = randomUUID();
  const item = session();
  for (const payload of [null, [], 'Stop', { hook_event_name: 'Stop' }, { session_id: '--resume', hook_event_name: 'Stop' }, { session_id: id, hook_event_name: 'assistant-message' }, { session_id: id, type: 'agent-turn-complete' }]) {
    assert.equal(nativeHookPatch(item, payload), null);
  }
  const ready = nativeHookPatch(item, { session_id: id, hook_event_name: 'SessionStart' }, id);
  assert.equal(ready?.nativeSessionId, id);
  assert.equal(ready?.status, 'idle');
  assert.equal(ready?.forkPending, false);
  assert.equal(nativeHookPatch(item, { session_id: id, hook_event_name: 'Stop' }, randomUUID()), null);
});

test('fork initialization must identify an independent native child and cannot rebind known contacts', () => {
  const parent = randomUUID(), child = randomUUID();
  const fork = session({ nativeSessionId: parent, forkPending: true });
  assert.equal(nativeHookPatch(fork, { session_id: parent, hook_event_name: 'SessionStart' }), null);
  const patch = nativeHookPatch(fork, { session_id: child, hook_event_name: 'SessionStart' }, child);
  assert.equal(patch?.nativeSessionId, child);
  assert.equal(patch?.forkPending, false);
  assert.equal(nativeHookPatch(session({ nativeSessionId: parent }), { session_id: child, hook_event_name: 'Stop' }), null);
});

test('approval and completion hooks preserve native semantics without copying payload text', () => {
  const id = randomUUID();
  const item = session({ nativeSessionId: id });
  const approval = nativeHookPatch(item, { session_id: id, hook_event_name: 'PermissionRequest', tool_input: 'secret command' });
  assert.equal(approval?.status, 'waiting_approval');
  assert.ok(!JSON.stringify(approval).includes('secret command'));
  assert.equal(nativeHookPatch(item, { session_id: id, hook_event_name: 'UserPromptSubmit' })?.status, 'running');
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    const continued = nativeHookPatch(item, { session_id: id, hook_event_name: event, tool_response: 'private tool result' });
    assert.equal(continued?.status, 'running');
    assert.ok(!JSON.stringify(continued).includes('private tool result'));
  }
  const done = nativeHookPatch(item, { session_id: id, hook_event_name: 'Stop' });
  assert.equal(done?.status, 'waiting_input');
  assert.ok(!('unread' in done!));
  const codex = session({ backend: 'codex' });
  assert.equal(nativeHookPatch(codex, { 'thread-id': id, type: 'agent-turn-complete' })?.status, 'waiting_input');
  assert.equal(nativeHookPatch(codex, { session_id: id, hook_event_name: 'Stop' }), null);
  assert.equal(nativeHookPatch(session({ backend: 'dsh' }), { session_id: id, hook_event_name: 'Stop' }), null);
});
