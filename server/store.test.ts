import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Store } from './store.ts';
import type { GroupMessage } from '../shared/types.ts';

function memory(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

function groupFixture(t: TestContext) {
  const store = memory(t);
  const group = store.addGroup('登录功能', '实现并验证登录');
  const member = store.addSession({ backend: 'codex', title: '实现', cwd: '/tmp', groupId: group.id });
  const reviewer = store.addSession({ backend: 'claude', title: '审查', cwd: '/tmp', groupId: group.id });
  const message: Omit<GroupMessage, 'id' | 'createdAt'> = {
    groupId: group.id, senderId: null, senderName: '用户', kind: 'task',
    text: '请检查登录边界', recipientIds: [member.id],
  };
  return { store, group, member, reviewer, message };
}

test('restart preserves renamed contacts and fork identities while clearing phantom live state', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sessiondeck-store-test-'));
  const database = join(directory, 'state.sqlite');
  let store: Store | undefined;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  store = new Store(database);
  const group = store.addGroup('功能群组', '一起实现功能');
  const parent = store.addSession({
    backend: 'codex', title: '原会话', cwd: '/tmp', nativeSessionId: 'native-parent',
  });
  const child = store.addSession({
    backend: 'codex', title: '分支', cwd: '/tmp', parentId: parent.id, groupId: group.id,
    origin: 'forked', nativeSessionId: 'native-child', running: true, status: 'running',
    nativeUrl: 'http://127.0.0.1:12345',
  });
  store.updateSession(child.id, { title: '群内实现' });
  const message = store.addMessage({
    groupId: group.id, senderId: null, senderName: '用户', kind: 'task', text: '继续实现', recipientIds: [child.id],
  });
  store.close();
  store = undefined;
  store = new Store(database);

  const recovered = store.session(child.id)!;
  assert.equal(recovered.title, '群内实现');
  assert.equal(recovered.parentId, parent.id);
  assert.equal(recovered.groupId, group.id);
  assert.equal(recovered.nativeSessionId, 'native-child');
  assert.equal(recovered.origin, 'forked');
  assert.equal(recovered.running, false);
  assert.equal(recovered.status, 'unknown');
  assert.equal(recovered.nativeUrl, null);
  assert.match(recovered.statusDetail, /重新启动/);
  assert.equal(store.session(parent.id)?.nativeSessionId, 'native-parent');
  assert.equal(store.session(parent.id)?.groupId, null);
  assert.equal(store.session(parent.id)?.status, 'idle');
  assert.equal(store.groupDetail(group.id).messages[0]?.id, message.id);
  assert.equal(store.groupDetail(group.id).deliveries[0]?.status, 'pending');
});

test('recipient validation rejects missing, foreign and archived contacts without partial writes', t => {
  const { store, group, member, message } = groupFixture(t);
  const otherGroup = store.addGroup('其他群组', '另一个目标');
  const foreign = store.addSession({ backend: 'dsh', title: '其他成员', cwd: '/tmp', groupId: otherGroup.id });
  const archived = store.addSession({ backend: 'claude', title: '已归档', cwd: '/tmp', groupId: group.id, archived: true });
  const originalGroup = store.group(group.id);

  for (const invalidId of ['missing-session', foreign.id, archived.id]) {
    assert.throws(() => store.addMessage({ ...message, recipientIds: [member.id, invalidId] }), /接收成员/);
    assert.equal(store.groupDetail(group.id).messages.length, 0);
    assert.equal(store.deliveries().length, 0);
    assert.deepEqual(store.group(group.id), originalGroup);
  }
});

test('sender must belong to the group before a result can be attributed to it', t => {
  const { store, group, member, message } = groupFixture(t);
  const foreign = store.addSession({ backend: 'dsh', title: '私聊联系人', cwd: '/tmp' });
  for (const senderId of ['missing-session', foreign.id]) {
    assert.throws(() => store.addMessage({ ...message, kind: 'result', senderId }), /发送者/);
  }
  assert.equal(store.groupDetail(group.id).messages.length, 0);
  assert.equal(store.deliveries().length, 0);
  const result = store.addMessage({ ...message, kind: 'result', senderId: member.id, senderName: member.title, recipientIds: [] });
  assert.equal(result.senderId, member.id);
  assert.equal(store.groupDetail(group.id).messages.length, 1);
});

test('database failure during the second delivery rolls back the message and first delivery', t => {
  const { store, group, member, reviewer, message } = groupFixture(t);
  // Reproduce a storage failure after one delivery was inserted, not just preflight validation.
  store.db.exec(`CREATE TRIGGER fail_second_delivery BEFORE INSERT ON deliveries
    WHEN (SELECT count(*) FROM deliveries) >= 1
    BEGIN SELECT RAISE(ABORT, 'simulated delivery failure'); END;`);
  assert.throws(() => store.addMessage({ ...message, recipientIds: [member.id, reviewer.id] }), /simulated delivery failure/);
  assert.equal(store.groupDetail(group.id).messages.length, 0);
  assert.equal(store.deliveries().length, 0);
  store.db.exec('DROP TRIGGER fail_second_delivery');
  const recovered = store.addMessage(message);
  assert.equal(store.groupDetail(group.id).messages[0]?.id, recovered.id);
  assert.equal(store.deliveries().length, 1);
});

test('duplicate recipients create one pending delivery per member with the shared goal', t => {
  const { store, group, member, reviewer, message } = groupFixture(t);
  const saved = store.addMessage({ ...message, recipientIds: [member.id, reviewer.id, member.id, reviewer.id] });
  assert.deepEqual(saved.recipientIds, [member.id, reviewer.id]);
  const deliveries = store.groupDetail(group.id).deliveries;
  assert.equal(deliveries.length, 2);
  assert.deepEqual(new Set(deliveries.map(d => d.sessionId)), new Set([member.id, reviewer.id]));
  for (const delivery of deliveries) {
    assert.equal(delivery.messageId, saved.id);
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.sentAt, null);
    assert.ok(store.delivery(delivery.id)!.text.includes(group.goal));
    assert.ok(store.delivery(delivery.id)!.text.includes(message.text));
  }
});

test('staged and cancelled deliveries cannot be processed a second time', t => {
  const { store, member, reviewer, message } = groupFixture(t);
  store.addMessage({ ...message, recipientIds: [member.id, reviewer.id] });
  const [first, second] = store.deliveries();
  const staged = store.updateDelivery(first!.id, 'staged');
  assert.equal(staged.status, 'staged');
  assert.ok(staged.sentAt);
  assert.throws(() => store.updateDelivery(first!.id, 'staged'), /不能重复/);
  assert.throws(() => store.updateDelivery(first!.id, 'sent'), /不能重复/);
  assert.deepEqual(store.delivery(first!.id), staged);
  const cancelled = store.updateDelivery(second!.id, 'cancelled');
  assert.equal(cancelled.sentAt, null);
  assert.throws(() => store.updateDelivery(second!.id, 'staged'), /不能重复/);
  assert.throws(() => store.updateDelivery('missing', 'staged'), /不存在/);
});

test('groups expose only their own messages and deliveries', t => {
  const { store, group, message } = groupFixture(t);
  const other = store.addGroup('另一组', '另外的目标');
  const local = store.addMessage(message);
  store.addMessage({ ...message, groupId: other.id, recipientIds: [], text: '另一组记录' });
  const detail = store.groupDetail(group.id);
  assert.deepEqual(detail.messages.map(m => m.id), [local.id]);
  assert.ok(detail.deliveries.every(d => d.messageId === local.id));
  assert.deepEqual(store.groupDetail(other.id).deliveries, []);
  assert.throws(() => store.addMessage({ ...message, groupId: 'missing-group' }), /群组不存在/);
});

test('group history revisions change for delivery updates, but not unrelated contact activity', t => {
  const { store, group, member, reviewer, message } = groupFixture(t);
  store.addMessage({ ...message, recipientIds: [member.id, reviewer.id] });
  const initial = store.group(group.id)!.updatedAt;
  store.updateSession(member.id, { status: 'running' });
  assert.equal(store.group(group.id)!.updatedAt, initial);
  const [first, second] = store.deliveries();
  store.updateDelivery(first!.id, 'staged');
  const staged = store.group(group.id)!.updatedAt;
  assert.ok(staged > initial);
  store.updateDelivery(second!.id, 'cancelled');
  assert.ok(store.group(group.id)!.updatedAt > staged);
  const detail = store.groupDetail(group.id);
  assert.deepEqual(detail.deliveries.map(delivery => delivery.status), ['staged', 'cancelled']);
});

test('group handoffs preserve a local result source and reject foreign or missing provenance', t => {
  const { store, group, member, reviewer, message } = groupFixture(t);
  const result = store.addMessage({ ...message, kind: 'result', senderId: member.id, senderName: member.title, recipientIds: [] });
  const other = store.addGroup('无关群组', '无关目标');
  const foreign = store.addMessage({ ...message, groupId: other.id, recipientIds: [] });
  for (const sourceMessageId of ['missing', foreign.id]) {
    assert.throws(() => store.addMessage({ ...message, sourceMessageId }), /转交来源/);
  }
  assert.equal(store.groupDetail(group.id).messages.length, 1);
  assert.equal(store.groupDetail(group.id).deliveries.length, 0);
  const handoff = store.addMessage({ ...message, kind: 'task', text: '根据这份结果继续验证。', sourceMessageId: result.id, recipientIds: [reviewer.id] });
  const detail = store.groupDetail(group.id);
  assert.equal(detail.messages[1].sourceMessageId, result.id);
  assert.equal(detail.deliveries[0].messageId, handoff.id);
  assert.equal(detail.deliveries[0].sessionId, reviewer.id);
  assert.ok(store.delivery(detail.deliveries[0].id)!.text.includes(member.title));
  assert.ok(store.delivery(detail.deliveries[0].id)!.text.includes('根据这份结果继续验证。'));
});
