import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from './store.ts';
import { StatePublisher } from './state.ts';
import { applyStatePatch } from '../client/state.ts';

test('committed metadata produces small ordered patches without full table rereads', t => {
  const store = new Store(':memory:');
  for (let i = 0; i < 500; i++) store.addSession({ backend: 'codex', title: `contact ${i}`, cwd: '/tmp' });
  const publisher = new StatePublisher(store, { instanceId: 'first', backends: [], defaultCwd: '/tmp', demo: true });
  t.after(() => { publisher.close(); store.close(); });
  const before = publisher.snapshot();
  store.sessions = () => assert.fail('must not reread all sessions');
  store.groups = () => assert.fail('must not reread all groups');
  store.activities = () => assert.fail('must not reread all activities');
  store.updateSession(before.sessions[10].id, { status: 'running' });
  const during = publisher.snapshot();
  store.updateSession(before.sessions[11].id, { status: 'waiting_approval' });
  const patch = publisher.takePatch()!;
  assert.equal(patch.sessions!.length, 2);
  assert.equal(patch.groups, undefined);
  assert.ok(JSON.stringify(patch).length < JSON.stringify(before).length / 100);
  const applied = applyStatePatch(before, patch)!;
  assert.deepEqual(applied, publisher.snapshot());
  assert.equal(applied.sessions[0], before.sessions[0], 'unchanged contacts preserve references');
  assert.deepEqual(applyStatePatch(during, patch), applied, 'HTTP snapshot may overlap an unpublished patch');
  assert.equal(applyStatePatch(applied, patch), applied, 'duplicate patch is ignored');
  assert.equal(applyStatePatch(before, { ...patch, baseRevision: patch.revision + 1, revision: patch.revision + 2 }), null);
  assert.equal(applyStatePatch(before, { ...patch, instanceId: 'restarted' }), null);
  assert.equal(publisher.takePatch(), null);
});

test('rolled back rows never escape through snapshots or delta events', t => {
  const store = new Store(':memory:');
  const publisher = new StatePublisher(store, { instanceId: 'first', backends: [], defaultCwd: '/tmp', demo: true });
  t.after(() => { publisher.close(); store.close(); });
  assert.throws(() => store.transaction(() => { store.addGroup('rolled back', ''); store.addSession({ backend: 'codex', title: 'partial', cwd: '/tmp' }); throw new Error('abort'); }));
  assert.equal(publisher.snapshot().groups.length, 0);
  assert.equal(publisher.snapshot().sessions.length, 0);
  assert.equal(publisher.takePatch(), null);
  store.addGroup('committed', '');
  assert.equal(publisher.takePatch()!.groups![0].title, 'committed');
});

test('activity patches retain the newest 100 entries across coalescing and reconnect', t => {
  const store = new Store(':memory:');
  for (let i = 0; i < 100; i++) store.activity(null, 'test', String(i));
  const publisher = new StatePublisher(store, { instanceId: 'first', backends: [], defaultCwd: '/tmp', demo: true });
  t.after(() => { publisher.close(); store.close(); });
  const initial = publisher.snapshot();
  for (let i = 100; i < 350; i++) store.activity(null, 'test', String(i));
  const patch = publisher.takePatch()!;
  assert.equal(patch.activities?.upsert.length, 100);
  assert.deepEqual(applyStatePatch(initial, patch), publisher.snapshot());
  assert.deepEqual(publisher.snapshot().activities, store.activities());
});
