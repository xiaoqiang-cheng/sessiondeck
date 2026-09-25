import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from './store.ts';
import { DeliveryNotAcceptedError, sendDelivery } from './delivery.ts';

function fixture(store: Store) {
  const group = store.addGroup('delivery', 'test');
  const member = store.addSession({ backend: 'dsh', title: 'member', cwd: '/tmp', groupId: group.id });
  store.addMessage({ groupId: group.id, senderId: null, senderName: 'user', kind: 'task', text: 'once', recipientIds: [member.id] });
  return store.groupDetail(group.id).deliveries[0].id;
}

test('lost native acknowledgement blocks repeat sends until the exact attempt is resolved', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const id = fixture(store); let accepted = 0;
  await assert.rejects(sendDelivery(store, id, 'sent', () => { accepted++; throw new Error('lost response'); }), /结果待确认/);
  const unknown = store.delivery(id)!;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.attempts?.[0].outcome, 'unknown');
  await assert.rejects(sendDelivery(store, id, 'sent', () => { accepted++; }), /不能重复/);
  assert.equal(accepted, 1);
  assert.throws(() => store.resolveDelivery(id, 'stale', 'not_received'), /已更新/);
  const confirmed = store.resolveDelivery(id, unknown.attempts![0].id, 'confirmed');
  assert.equal(confirmed.status, 'sent');
  assert.throws(() => store.resolveDelivery(id, unknown.attempts![0].id, 'not_received'), /已更新/);
});

test('only explicit non-acceptance or human verification permits another attempt', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const id = fixture(store);
  await assert.rejects(sendDelivery(store, id, 'sent', () => { throw new DeliveryNotAcceptedError('not attached'); }), /not attached/);
  assert.equal(store.delivery(id)!.status, 'pending');
  await assert.rejects(sendDelivery(store, id, 'sent', () => { throw new Error('timeout'); }));
  store.resolveDelivery(id, store.delivery(id)!.attempts!.at(-1)!.id, 'not_received');
  const sent = await sendDelivery(store, id, 'sent', () => {});
  assert.equal(sent.status, 'sent');
  assert.deepEqual(sent.attempts!.map(attempt => attempt.outcome), ['rejected', 'unknown', 'sent']);
});

test('a crash while sending recovers as unknown and retains native acknowledgement evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sessiondeck-delivery-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const id = fixture(store);
  const attempt = store.beginDelivery(id, 'staged');
  store.close(); store = new Store(path);
  assert.equal(store.delivery(id)?.status, 'unknown');
  assert.equal(store.delivery(id)?.attempts?.[0].id, attempt.id);
  await assert.rejects(sendDelivery(store, id, 'staged', () => assert.fail('must not repeat')));
  assert.equal(store.resolveDelivery(id, attempt.id, 'confirmed').status, 'staged');
});

test('failure to persist success never silently reopens a delivery for retry', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const id = fixture(store);
  store.db.exec(`CREATE TRIGGER fail_sent BEFORE UPDATE ON deliveries WHEN json_extract(NEW.data, '$.status') = 'sent' BEGIN SELECT RAISE(ABORT, 'disk error'); END;`);
  let accepted = 0;
  await assert.rejects(sendDelivery(store, id, 'sent', () => { accepted++; }), /结果待确认/);
  assert.equal(store.delivery(id)!.status, 'unknown');
  await assert.rejects(sendDelivery(store, id, 'sent', () => { accepted++; }));
  assert.equal(accepted, 1);
});
