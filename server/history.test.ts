import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from './store.ts';

test('history pages are bounded and continuous; delivery changes use a resumable change cursor', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const group = store.addGroup('large', '');
  const member = store.addSession({ backend: 'codex', title: 'member', cwd: '/tmp', groupId: group.id });
  const start = group.updatedAt;
  const ids = Array.from({ length: 451 }, (_, i) => store.addMessage({ groupId: group.id, senderId: null, senderName: 'user', kind: 'task', text: `${i}:` + 'x'.repeat(2048), recipientIds: [member.id] }).id);
  let page = store.groupDetail(group.id);
  const revision = page.revision!;
  assert.equal(page.messages.length, 200);
  assert.equal(page.page!.total, 451);
  assert.equal(page.deliveries.length, 200);
  assert.equal('text' in page.deliveries[0], false);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 600_000);
  const history = [...page.messages];
  while (page.page!.before) { page = store.groupDetail(group.id, { before: page.page!.before }); history.unshift(...page.messages); }
  assert.deepEqual(history.map(message => message.id), ids);
  assert.deepEqual(store.groupDetail(group.id, { since: revision }).messages, []);
  const delivery = store.groupDetail(group.id).deliveries[0];
  store.updateDelivery(delivery.id, 'cancelled');
  const delta = store.groupDetail(group.id, { since: revision });
  assert.deepEqual(delta.messages.map(message => message.id), [delivery.messageId]);
  assert.equal(delta.deliveries[0].status, 'cancelled');
  assert.equal(store.message(ids[0])!.id, ids[0], 'unloaded source is addressable independently');
  const changes: string[] = []; let since = start;
  do { const next = store.groupDetail(group.id, { since }); changes.push(...next.messages.map(message => message.id)); since = next.nextSince ?? ''; } while (since);
  assert.equal(changes.length, 451);
  assert.deepEqual(new Set(changes), new Set(ids));
  assert.throws(() => store.groupDetail(group.id, { before: -1 }), /游标/);
  assert.throws(() => store.groupDetail(group.id, { since: 'invalid' }), /版本/);
});

test('delivery page probes its message index regardless of unrelated group size', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const group = store.addGroup('small', '');
  const member = store.addSession({ backend: 'codex', title: 'member', cwd: '/tmp', groupId: group.id });
  const message = store.addMessage({ groupId: group.id, senderId: null, senderName: 'user', kind: 'task', text: 'small', recipientIds: [member.id] });
  const original = store.db.prepare.bind(store.db);
  const plans: string[] = [];
  store.db.prepare = sql => {
    if (sql.includes("SELECT json_remove(data, '$.text')")) plans.push(...original(`EXPLAIN QUERY PLAN ${sql}`).all(message.id).map(row => String(row.detail)));
    return original(sql);
  };
  const result = store.groupDetail(group.id);
  assert.equal(result.deliveries.length, 1);
  assert.ok(plans.some(plan => /SEARCH deliveries USING INDEX deliveries_message/.test(plan)), plans.join('\n'));
  assert.ok(plans.every(plan => !/SCAN deliveries/.test(plan)));
});

test('legacy messages without a revision acquire a cursor when their delivery changes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const group = store.addGroup('legacy', '');
  const member = store.addSession({ backend: 'codex', title: 'member', cwd: '/tmp', groupId: group.id });
  const message = store.addMessage({ groupId: group.id, senderId: null, senderName: 'user', kind: 'task', text: 'legacy message', recipientIds: [member.id] });
  store.db.prepare("UPDATE messages SET data = json_remove(data, '$.revision') WHERE id = ?").run(message.id);
  const initial = store.groupDetail(group.id);
  assert.equal(initial.messages[0].revision, undefined);
  store.updateDelivery(initial.deliveries[0].id, 'cancelled');
  const next = store.groupDetail(group.id, { since: initial.revision });
  assert.equal(next.messages[0].id, message.id);
  assert.equal(next.deliveries[0].status, 'cancelled');
  assert.ok(next.messages[0].revision! > Date.parse(initial.revision!));
});
