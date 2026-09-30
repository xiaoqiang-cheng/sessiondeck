import { mutationHeaders, test } from './fixtures';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { AppState, Group, GroupDetail, Session } from '../shared/types';

async function readState(request: APIRequestContext) {
  const state = await (await request.get('/api/state')).json() as AppState;
  expect(state.demo, 'recovery browser tests must only use the model-free demo backend').toBe(true);
  return state;
}

async function mutate<T>(request: APIRequestContext, path: string, body: unknown = {}, method = 'POST'): Promise<T> {
  const headers = await mutationHeaders(request);
  const response = await request.fetch(`/api${path}`, { method, data: body, headers });
  expect(response.ok(), `demo API ${method} ${path} should succeed`).toBeTruthy();
  return await response.json() as T;
}

async function createSession(request: APIRequestContext, title: string, groupId?: string) {
  const state = await readState(request);
  return mutate<Session>(request, '/sessions', { backend: 'codex', title, cwd: state.defaultCwd, groupId });
}

function observeTerminal(page: Page) {
  const frames: string[] = [];
  page.on('websocket', socket => {
    if (!socket.url().includes('/api/terminal/')) return;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload)) as { type: string; data?: string };
      if (message.type === 'data' && message.data) frames.push(message.data);
    });
  });
  return frames;
}

async function enterSession(page: Page, session: Session) {
  await page.goto(`/#/contacts?session=${session.id}`);
  await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` })).toBeVisible();
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
}

async function sendTerminal(page: Page, text: string) {
  await page.getByLabel('原生会话终端输入').pressSequentially(text);
  await page.getByLabel('原生会话终端输入').press('Enter');
}

async function installTransportHandles(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as { recoverySockets: WebSocket[]; recoverySource: EventSource };
    target.recoverySockets = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols); target.recoverySockets.push(this);
      }
    };
    const NativeSource = window.EventSource;
    window.EventSource = class extends NativeSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options); target.recoverySource = this;
      }
    };
  });
}

/** Deterministic state delivery for tests that deliberately reorder snapshots. */
async function installStateStream(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as { recoverySource: EventTarget };
    class StateSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor() {
        super(); target.recoverySource = this;
        this.addEventListener('open', event => this.onopen?.(event));
        this.addEventListener('error', event => this.onerror?.(event));
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: StateSource });
  });
}

async function installNotificationRecorder(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sessiondeck.notifications', 'on');
    const target = window as unknown as { testNotifications: { title: string; tag?: string }[] };
    target.testNotifications = [];
    class TestNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) { target.testNotifications.push({ title, tag: options?.tag }); }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
  });
}

test('multiple tabs share one native session without stopping it, and separate sessions keep their output isolated', async ({ page, context }) => {
  const first = await createSession(page.request, '多标签同会话回归');
  const second = await createSession(page.request, '多标签独立会话回归');
  await mutate(page.request, `/sessions/${first.id}/start`);
  await mutate(page.request, `/sessions/${second.id}/start`);
  const peer = await context.newPage();
  const other = await context.newPage();
  const ownFrames = observeTerminal(page);
  const peerFrames = observeTerminal(peer);
  const otherFrames = observeTerminal(other);
  try {
    await Promise.all([enterSession(page, first), enterSession(peer, first), enterSession(other, second)]);
    await sendTerminal(page, 'SAME-SESSION-ROUND-ONE');
    await expect.poll(() => ownFrames.join('')).toContain('SAME-SESSION-ROUND-ONE');
    await expect.poll(() => peerFrames.join('')).toContain('SAME-SESSION-ROUND-ONE');
    expect(otherFrames.join('')).not.toContain('SAME-SESSION-ROUND-ONE');
    await page.getByRole('button', { name: '关闭会话', exact: true }).click();
    await sendTerminal(peer, 'SAME-SESSION-AFTER-CLOSE');
    await expect.poll(() => peerFrames.join('')).toContain('SAME-SESSION-AFTER-CLOSE');
    expect((await readState(page.request)).sessions.find(session => session.id === first.id)?.running).toBe(true);
    await sendTerminal(other, 'OTHER-SESSION-ONLY');
    await expect.poll(() => otherFrames.join('')).toContain('OTHER-SESSION-ONLY');
    expect(peerFrames.join('')).not.toContain('OTHER-SESSION-ONLY');
  } finally {
    await mutate(page.request, `/sessions/${first.id}/stop`);
    await mutate(page.request, `/sessions/${second.id}/stop`);
    await peer.close(); await other.close();
  }
});

test('terminal transport reconnects after a simulated service outage and replays the same context', async ({ page }) => {
  const session = await createSession(page.request, '断线终端恢复回归');
  await mutate(page.request, `/sessions/${session.id}/start`);
  await installTransportHandles(page);
  const frames = observeTerminal(page);
  try {
    await enterSession(page, session);
    await sendTerminal(page, 'BEFORE-CONNECTION-LOSS');
    await expect.poll(() => frames.join('')).toContain('BEFORE-CONNECTION-LOSS');
    let failedConnections = 0;
    await page.route('**/api/config', route => { failedConnections++; return route.abort('connectionrefused'); });
    await page.evaluate(() => {
      const target = window as unknown as { recoverySockets: WebSocket[]; recoverySource: EventSource };
      target.recoverySource.dispatchEvent(new Event('error'));
      target.recoverySockets.at(-1)?.close(1000, 'test connection loss');
    });
    await expect(page.locator('.terminal-connection')).toHaveText('连接中');
    await expect(page.locator('.terminal-error')).toContainText('重连');
    await expect(page.locator('.connection-banner')).toContainText('服务连接已中断');
    await expect.poll(() => failedConnections).toBeGreaterThan(0);
    const beforeReplay = frames.length;
    await page.unroute('**/api/config');
    await page.evaluate(() => (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new Event('open')));
    await expect(page.locator('.terminal-connection')).toHaveText('已连接');
    await expect(page.locator('.connection-banner')).not.toBeVisible();
    await expect.poll(() => frames.slice(beforeReplay).join('')).toContain('BEFORE-CONNECTION-LOSS');
    await sendTerminal(page, 'AFTER-CONNECTION-RECOVERY');
    await expect.poll(() => frames.join('')).toContain('AFTER-CONNECTION-RECOVERY');
    expect((await readState(page.request)).sessions.find(item => item.id === session.id)?.running).toBe(true);
  } finally { await mutate(page.request, `/sessions/${session.id}/stop`); }
});

test('running contacts require stopping before archive, and restoring does not restart the process', async ({ page }) => {
  const session = await createSession(page.request, '停止与归档回归');
  await mutate(page.request, `/sessions/${session.id}/start`);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: `${session.title} 的更多操作`, exact: true }).click();
    await page.getByRole('button', { name: '归档联系人', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请先停止会话，再归档');
    let current = (await readState(page.request)).sessions.find(item => item.id === session.id)!;
    expect(current.running).toBe(true); expect(current.archived).toBe(false);
    await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '停止进程', exact: true }).click();
    await expect(page.getByRole('button', { name: '启动原生会话', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '关闭会话', exact: true }).click();
    await page.getByRole('button', { name: `${session.title} 的更多操作`, exact: true }).click();
    await page.getByRole('button', { name: '归档联系人', exact: true }).click();
    await expect(page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true })).not.toBeVisible();
    await page.goto(`/#/archive?session=${session.id}`);
    await expect(page.getByRole('button', { name: '已归档 · 恢复联系人', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '启动原生会话', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '已归档 · 恢复联系人', exact: true }).click();
    await expect(page.getByRole('button', { name: '启动原生会话', exact: true })).toBeEnabled();
    current = (await readState(page.request)).sessions.find(item => item.id === session.id)!;
    expect(current.archived).toBe(false); expect(current.running).toBe(false);
  } finally { await mutate(page.request, `/sessions/${session.id}/stop`); }
});

test('directed group delivery stays pending on failure, retries once, and cancellation updates the board', async ({ page }) => {
  await readState(page.request);
  await installTransportHandles(page);
  const group = await mutate<Group>(page.request, '/groups', { title: '定向投递恢复回归', goal: '验证失败不丢失待办' });
  const member = await createSession(page.request, '投递恢复成员', group.id);
  try {
    await page.goto(`/#/groups/${group.id}`);
    await page.getByRole('button', { name: '分配任务', exact: true }).click();
    await page.locator('.recipient-picker').getByRole('button', { name: /投递恢复成员/ }).click();
    await page.getByLabel('群组消息').fill('RECOVERY-TASK-ONE');
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByRole('button', { name: '填入会话', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请先进入并启动目标会话');
    let detail = await (await page.request.get(`/api/groups/${group.id}`)).json() as GroupDetail;
    expect(detail.deliveries).toHaveLength(1); expect(detail.deliveries[0].status).toBe('pending');
    await mutate(page.request, `/sessions/${member.id}/start`);
    const deliveryId = detail.deliveries[0].id;
    await page.route(`**/api/deliveries/${deliveryId}/send`, route => route.fulfill({ status: 503, json: { error: '模拟投递暂时不可用' } }));
    await page.getByRole('button', { name: '填入会话', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('模拟投递暂时不可用');
    const freshSnapshot = await readState(page.request);
    await page.evaluate(snapshot => (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) })), freshSnapshot);
    await expect(page.getByRole('alert')).toContainText('模拟投递暂时不可用');
    await expect(page.getByRole('button', { name: '填入会话', exact: true })).toBeEnabled();
    await page.unroute(`**/api/deliveries/${deliveryId}/send`);
    await page.getByRole('button', { name: '填入会话', exact: true }).click();
    await expect(page.getByRole('dialog', { name: `${member.title} 的私聊` })).toBeVisible();
    await page.getByRole('button', { name: '关闭会话', exact: true }).click();
    await expect(page.getByText('已填入 · 在私聊按回车发送')).toBeVisible();
    await page.locator('.recipient-picker').getByRole('button', { name: /投递恢复成员/ }).click();
    await page.getByLabel('群组消息').fill('RECOVERY-TASK-CANCEL');
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByRole('button', { name: '取消投递', exact: true }).click();
    await expect(page.getByText('已取消', { exact: true })).toBeVisible();
    detail = await (await page.request.get(`/api/groups/${group.id}`)).json() as GroupDetail;
    expect(detail.deliveries.map(delivery => delivery.status).sort()).toEqual(['cancelled', 'staged']);
    expect(detail.messages).toHaveLength(2);
  } finally { await mutate(page.request, `/sessions/${member.id}/stop`); }
});

test('repeated state snapshots and reconnection do not repeat the same attention notification', async ({ page }) => {
  const session = await createSession(page.request, '通知去重回归');
  const state = await readState(page.request);
  await installStateStream(page);
  await installNotificationRecorder(page);
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true })).toBeVisible();
  const target = state.sessions.find(item => item.id === session.id)!;
  target.status = 'waiting_input'; target.statusDetail = '等待继续说明'; target.unread += 1;
  for (let index = 0; index < 4; index++) {
    await page.evaluate(snapshot => {
      (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) }));
    }, state);
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { testNotifications: unknown[] }).testNotifications.length)).toBe(1);
  await page.evaluate(() => {
    const source = (window as unknown as { recoverySource: EventSource }).recoverySource;
    source.dispatchEvent(new Event('error')); source.dispatchEvent(new Event('open'));
  });
  await expect(page.locator('.connection-banner')).not.toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { testNotifications: unknown[] }).testNotifications.length)).toBe(1);
  target.status = 'unknown';
  await page.evaluate(snapshot => (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) })), state);
  target.status = 'waiting_input';
  await page.evaluate(snapshot => (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) })), state);
  expect(await page.evaluate(() => (window as unknown as { testNotifications: unknown[] }).testNotifications.length)).toBe(1);
  target.unread += 1;
  await page.evaluate(snapshot => (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) })), state);
  await expect.poll(() => page.evaluate(() => (window as unknown as { testNotifications: unknown[] }).testNotifications.length)).toBe(2);
});

test('a failed initial snapshot does not leave a connection error after live state has recovered', async ({ page }) => {
  await readState(page.request);
  let snapshots = 0;
  await page.route('**/api/state', route => snapshots++ === 0 ? route.abort('connectionrefused') : route.continue());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '会话联系人', exact: true })).toBeVisible();
  await expect(page.locator('.connection-indicator')).toContainText('本地服务已连接');
  await expect(page.getByRole('button', { name: '进入 SessionDeck · 开发笔记 的会话', exact: true })).toBeVisible();
  await expect(page.locator('.error-banner')).not.toBeVisible();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/recovered-workspace.png', fullPage: true });
});

test('a background tab refreshes on return and keeps new in-app attention visible until acknowledged', async ({ page }) => {
  const session = await createSession(page.request, '后台提醒恢复回归');
  let state = await readState(page.request);
  await installStateStream(page);
  await page.addInitScript(() => {
    const target = window as unknown as { recoveryVisibility: DocumentVisibilityState };
    target.recoveryVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => target.recoveryVisibility });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.goto(`/#/contacts?session=${session.id}`);
  await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` })).toBeVisible();
  const target = state.sessions.find(item => item.id === session.id)!;
  target.status = 'waiting_input'; target.statusSource = 'native'; target.statusDetail = '后台任务已完成，等待你验收'; target.unread = 1;
  await page.evaluate(snapshot => {
    (window as unknown as { recoveryVisibility: DocumentVisibilityState }).recoveryVisibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) }));
  }, state);
  // A hidden tab never reads on the user's behalf: the tab badge stays red.
  await expect(page.getByRole('tab', { name: new RegExp(session.title) }).locator('b')).toHaveCount(0);
  await expect(page.locator('.session-tab.active')).toHaveCount(1);
  let reads = 0;
  await page.route(`**/api/sessions/${session.id}/read`, route => {
    reads++;
    state = { ...state, sessions: state.sessions.map(item => item.id === session.id ? { ...item, unread: 0 } : item) };
    return route.fulfill({ json: state.sessions.find(item => item.id === session.id) });
  });
  expect(reads).toBe(0);
  state = { ...state, sessions: state.sessions.map(item => item.id === session.id ? { ...item, statusDetail: '恢复前台后已同步到最新结果', unread: 2 } : item) };
  await page.evaluate(() => {
    (window as unknown as { recoveryVisibility: DocumentVisibilityState }).recoveryVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Coming back to the open session shows the latest status inline and reads it.
  await expect(page.getByRole('dialog').locator('.session-status-detail')).toContainText('恢复前台后已同步到最新结果');
  await expect.poll(() => reads).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/session-unread.png', fullPage: true });
  await expect(page.getByRole('dialog').locator('.status-badge')).toHaveText('等待输入');
});

test('an unavailable initial service disables creation and gives a recoverable connection error', async ({ page }) => {
  await page.route('**/api/state', route => route.abort('connectionrefused'));
  await page.route('**/api/events', route => route.abort('connectionrefused'));
  await page.goto('/');
  await expect(page.locator('.connection-error')).toContainText('无法连接本地服务');
  await expect(page.getByRole('button', { name: '新建联系人', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '导入会话', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '创建群组', exact: true })).toBeDisabled();
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(page.locator('.connection-error')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '新建联系人', exact: true })).toBeEnabled();
});

test('late snapshots cannot undo live attention, and a restarted service adopts a fresh revision sequence', async ({ page }) => {
  const session = await createSession(page.request, '快照时序回归');
  const initial: AppState = { ...await readState(page.request), instanceId: 'recovery-server-first', revision: 10 };
  await installStateStream(page);
  await installNotificationRecorder(page);
  let releaseOld!: () => void;
  const held = new Promise<void>(resolve => { releaseOld = resolve; });
  let responses = 0;
  await page.route('**/api/state', async route => { await held; await route.fulfill({ json: initial }); responses++; });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { recoverySource?: EventSource }).recoverySource);
  const deliver = (snapshot: AppState) => page.evaluate(data => {
    (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(data) }));
  }, snapshot);
  await deliver(initial);
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: session.title }) });
  await expect(card).toBeVisible();
  const latest: AppState = { ...initial, revision: 11, sessions: initial.sessions.map(item => item.id === session.id ? { ...item, status: 'waiting_input', statusDetail: '最新结果等你验收', unread: 1 } : item) };
  await deliver(latest);
  await expect(card).toContainText('最新结果等你验收');
  releaseOld();
  await expect.poll(() => responses).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(card).toContainText('最新结果等你验收');
  await deliver(latest);
  expect(await page.evaluate(() => (window as unknown as { testNotifications: unknown[] }).testNotifications.length)).toBe(1);

  const restarted: AppState = { ...latest, instanceId: 'recovery-server-second', revision: 1, sessions: latest.sessions.map(item => item.id === session.id ? { ...item, statusDetail: '服务重启后继续保留提醒' } : item) };
  await deliver(restarted);
  await expect(card).toContainText('服务重启后继续保留提醒');
  await deliver({ ...initial, revision: 999 });
  await expect(card).toContainText('服务重启后继续保留提醒');
  await deliver({ ...restarted, revision: 2 });
  expect(await page.evaluate(() => (window as unknown as { testNotifications: unknown[] }).testNotifications.length)).toBe(1);
});

test('entity patches update cards, ignore duplicates, and resync a missing version', async ({ page }) => {
  await installStateStream(page);
  const seed = await readState(page.request);
  let state: AppState = { ...seed, instanceId: 'delta-server', revision: 10, sessions: [{ ...seed.sessions[0], groupId: null, archived: false }], groups: [], activities: [] };
  let snapshots = 0;
  let holdNext = false, heldRequest = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/state', async route => {
    snapshots++; const snapshot = structuredClone(state);
    if (holdNext) { holdNext = false; heldRequest = true; await held; }
    return route.fulfill({ json: snapshot });
  });
  await page.goto('/');
  const card = page.locator('.session-card');
  await expect(card).toHaveCount(1);
  const initialRequests = snapshots;
  const updated = { ...state.sessions[0], status: 'waiting_approval' as const, statusDetail: '原生审批等待处理', unread: 1 };
  const patch: import('../shared/types').StatePatch = { instanceId: state.instanceId!, baseRevision: 10, revision: 11, sessions: [updated] };
  const deliver = (value: typeof patch) => page.evaluate(data => (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('patch', { data: JSON.stringify(data) })), value);
  await deliver(patch);
  await expect(card).toContainText('原生审批等待处理');
  await deliver({ ...patch, sessions: state.sessions });
  await expect(card).toContainText('原生审批等待处理');
  expect(snapshots).toBe(initialRequests);
  state = { ...state, revision: 14, sessions: [{ ...updated, statusDetail: '补齐丢失版本后的状态' }] };
  holdNext = true;
  await deliver({ ...patch, baseRevision: 13, revision: 14 });
  await expect.poll(() => heldRequest).toBe(true);
  state = { ...state, revision: 16, sessions: [{ ...updated, statusDetail: '补齐期间再次更新的状态' }] };
  await deliver({ ...patch, baseRevision: 15, revision: 16 });
  release();
  await expect(card).toContainText('补齐期间再次更新的状态');
  await expect.poll(() => snapshots).toBe(initialRequests + 2);
});

test('uncertain deliveries require an explicit checked result before retrying', async ({ page }) => {
  await installStateStream(page);
  const seed = await readState(page.request);
  const group = { ...seed.groups[0], id: 'unknown-delivery', title: '待确认投递' };
  const member = { ...seed.sessions[0], groupId: group.id };
  const state = { ...seed, groups: [group], sessions: [member] };
  const detail: GroupDetail = { group, messages: [{ id: 'unknown-message', groupId: group.id, senderId: null, senderName: '你', kind: 'task', text: '发送后响应丢失', recipientIds: [member.id], createdAt: group.createdAt }], deliveries: [{ id: 'uncertain', messageId: 'unknown-message', sessionId: member.id, status: 'unknown', createdAt: group.createdAt, sentAt: null, attempts: [{ id: 'attempt-1', mode: 'staged', startedAt: group.createdAt, outcome: 'unknown' }] }], page: { total: 1, before: null }, revision: group.updatedAt };
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route(url => url.pathname === `/api/groups/${group.id}`, route => route.fulfill({ json: detail }));
  let resolutions = 0;
  await page.route('**/api/deliveries/uncertain/resolve', route => {
    expect(route.request().postDataJSON()).toEqual({ attemptId: 'attempt-1', resolution: 'not_received' });
    resolutions++;
    detail.deliveries[0].status = 'pending';
    group.updatedAt = new Date(Date.parse(group.updatedAt) + 1).toISOString(); detail.revision = group.updatedAt;
    state.revision = (state.revision ?? 0) + 1;
    return route.fulfill({ json: detail.deliveries[0] });
  });
  await page.goto(`/#/groups/${group.id}`);
  await expect(page.getByText('结果待确认，请核对原生会话')).toBeVisible();
  await expect(page.getByRole('button', { name: '填入会话', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '已核对，已收到', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '已核对，未收到', exact: true }).click();
  await expect(page.getByRole('button', { name: '填入会话', exact: true })).toBeEnabled();
  expect(resolutions).toBe(1);
  await expect(page.getByText('结果待确认，请核对原生会话')).toHaveCount(0);
});

test('an older page racing a delivery delta catches up without gaps or stale pending actions', async ({ page }) => {
  await installStateStream(page);
  const seed = await readState(page.request);
  const baseline = '2026-01-01T00:00:00.000Z', changed = '2026-01-01T00:00:00.001Z';
  const group = { ...seed.groups[0], id: 'history-race', updatedAt: baseline };
  const member = { ...seed.sessions[0], groupId: group.id };
  const state: AppState = { ...seed, instanceId: 'history-race-server', revision: 10, groups: [group], sessions: [member] };
  const messages = Array.from({ length: 201 }, (_, i) => ({ id: `race-${i}`, groupId: group.id, senderId: null, senderName: '你', kind: 'task' as const, text: `历史消息 ${i}`, recipientIds: [member.id], createdAt: baseline, sequence: i + 1, revision: Date.parse(baseline) }));
  const delivery = { id: 'race-delivery', messageId: 'race-0', sessionId: member.id, status: 'pending' as const, createdAt: baseline, sentAt: null };
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  let release!: () => void, olderRequested = false, deltas = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === `/api/groups/${group.id}`, async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has('before')) {
      olderRequested = true; await held;
      return route.fulfill({ json: { group, messages: [messages[0]], deliveries: [delivery], page: { total: 201, before: null }, revision: baseline } });
    }
    if (query.has('since')) {
      deltas++;
      return route.fulfill({ json: { group: { ...group, updatedAt: changed }, messages: [{ ...messages[0], revision: Date.parse(changed) }], deliveries: [{ ...delivery, status: 'cancelled' }], page: { total: 201, before: null }, revision: changed } });
    }
    return route.fulfill({ json: { group, messages: messages.slice(1), deliveries: [], page: { total: 201, before: 2 }, revision: baseline } });
  });
  await page.goto(`/#/groups/${group.id}`);
  await expect(page.locator('.group-message')).toHaveCount(200);
  await page.getByRole('button', { name: '显示更早 1 条', exact: true }).click();
  await expect.poll(() => olderRequested).toBe(true);
  await page.evaluate(data => (window as unknown as { recoverySource: EventSource }).recoverySource.dispatchEvent(new MessageEvent('patch', { data: JSON.stringify(data) })), { instanceId: state.instanceId, baseRevision: 10, revision: 11, groups: [{ ...group, updatedAt: changed }] });
  await expect.poll(() => deltas).toBe(1);
  await expect(page.locator('.group-message')).toHaveCount(200);
  release();
  await expect(page.locator('.group-message')).toHaveCount(201);
  await expect(page.locator('#group-message-race-0')).toContainText('已取消');
  await expect(page.locator('#group-message-race-0').getByRole('button', { name: '填入会话', exact: true })).toHaveCount(0);
});
