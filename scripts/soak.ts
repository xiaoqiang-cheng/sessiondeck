import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { AppState, Group, GroupMessage, Session } from '../shared/types.ts';

const minutes = Number(process.argv.find(arg => arg.startsWith('--minutes='))?.split('=')[1] || '10');
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 180) throw new Error('--minutes 必须在 0–180 之间');
const temporary = await mkdtemp(join(tmpdir(), 'sessiondeck-soak-'));
const allocation = createServer();
await new Promise<void>(accept => allocation.listen(0, '127.0.0.1', accept));
const address = allocation.address();
if (!address || typeof address === 'string') throw new Error('无法分配本地端口');
const port = address.port;
await new Promise<void>(accept => allocation.close(() => accept()));
const base = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: resolve('.'), env: { ...process.env, PORT: String(port), SESSIONDECK_PORT: String(port), SESSIONDECK_DEMO: '1', SESSIONDECK_DATA_DIR: temporary },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
service.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
service.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
const connections = new Set<WebSocket>();
const abortStreams = new AbortController();
const begin = Date.now();
const deadline = begin + minutes * 60_000;
let stopped = false;
let rounds = 0;
let token = '';
const metrics: { minute: number; rssKiB: number | null; descriptors: number | null; round: number }[] = [];
const result: Record<string, unknown> = { mode: 'isolated-demo-no-model', requestedMinutes: minutes, startedAt: new Date(begin).toISOString(), passed: false };
const onSignal = () => { stopped = true; };
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);

async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', 'x-sessiondeck-token': token },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const content = await response.json() as T & { error?: string };
  assert.ok(response.ok, `${path}: ${content.error || response.status}`);
  return content;
}

async function openTerminal(id: string) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/terminal/${id}?token=${token}`, { origin: base });
  connections.add(ws);
  ws.on('close', () => connections.delete(ws));
  ws.on('error', () => {});
  let data = '';
  ws.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'data') data = (data + event.data).slice(-100_000);
  });
  await Promise.race([once(ws, 'open'), delay(5000).then(() => { throw new Error('终端连接超时'); })]);
  return { ws, output: () => data };
}

async function until(check: () => boolean, description: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await delay(30); }
  throw new Error(description);
}

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { token = (await request<{ csrfToken: string }>('/api/config')).csrfToken; break; }
    catch { if (service.exitCode !== null) throw new Error(`服务启动失败：${output}`); await delay(100); }
  }
  assert.ok(token, '未获取操作凭证');
  const group = await request<Group>('/api/groups', { title: '稳定性验证', goal: '测试会话切换、原生终端回放、定向消息与长时间连接' });
  const members: Session[] = [];
  for (let i = 0; i < 3; i++) {
    const member = await request<Session>('/api/sessions', { title: `稳定性成员 ${i + 1}`, backend: ['claude', 'codex', 'dsh'][i], cwd: temporary, groupId: group.id });
    await request(`/api/sessions/${member.id}/start`, {}); members.push(member);
  }
  const stream = await fetch(`${base}/api/events`, { signal: abortStreams.signal });
  assert.equal(stream.status, 200);
  let events = 0;
  const streamTask = (async () => {
    const reader = stream.body!.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        events += [...new TextDecoder().decode(chunk.value).matchAll(/event: (?:state|patch)/g)].length;
      }
    } catch (error) { if (!abortStreams.signal.aborted) throw error; }
    finally { reader.releaseLock(); }
  })();
  streamTask.catch(() => { stopped = true; });
  let nextMetric = 0;
  while (Date.now() < deadline && !stopped) {
    rounds++;
    const index = (rounds - 1) % members.length;
    const member = members[index];
    const other = members[(index + 1) % members.length];
    const active = await openTerminal(member.id);
    const observer = await openTerminal(other.id);
    const marker = `round-${rounds}-${Date.now()}`;
    active.ws.send(JSON.stringify({ type: 'input', data: `${marker}\r` }));
    await until(() => active.output().includes(marker), '输入没有回到指定终端');
    assert.ok(!observer.output().includes(marker), '输入串入其他联系人');
    active.ws.close(); observer.ws.close();

    if (rounds % 6 === 0) {
      const message = await request<GroupMessage>(`/api/groups/${group.id}/messages`, { text: marker, kind: 'task', recipientIds: [member.id] });
      const detail = await request<{ deliveries: { id: string; messageId: string; status: string }[] }>(`/api/groups/${group.id}`);
      const delivery = detail.deliveries.find(item => item.messageId === message.id);
      assert.ok(delivery);
      await request(`/api/deliveries/${delivery.id}/send`, {});
      const connection = await openTerminal(member.id);
      connection.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
      await until(() => connection.output().includes(marker), '终端回放未包含投递任务');
      connection.ws.close();
    }
    if (rounds % 15 === 0) {
      await request(`/api/sessions/${member.id}/stop`, {});
      await request(`/api/sessions/${member.id}/start`, {});
    }
    const state = await request<AppState>('/api/state');
    assert.ok(members.every(member => state.sessions.find(item => item.id === member.id)?.running), '托管进程意外丢失');
    if (Date.now() >= nextMetric) {
      let rssKiB: number | null = null, descriptors: number | null = null;
      if (process.platform === 'linux' && service.pid) {
        rssKiB = Number((await readFile(`/proc/${service.pid}/status`, 'utf8')).match(/VmRSS:\s+(\d+)/)?.[1] || 0);
        descriptors = (await readdir(`/proc/${service.pid}/fd`)).length;
      }
      const metric = { minute: Math.round((Date.now() - begin) / 6000) / 10, rssKiB, descriptors, round: rounds };
      metrics.push(metric); nextMetric = Date.now() + 60_000;
      console.log(JSON.stringify({ ...metric, stateEvents: events }));
    }
    await delay(Math.min(3000, Math.max(0, deadline - Date.now())));
  }
  abortStreams.abort(); await streamTask;
  assert.ok(!stopped, '稳定性验证被中断');
  assert.ok(events > 0, '实时状态流没有更新');
  Object.assign(result, { passed: true, rounds, stateEvents: events });
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.serverOutput = output;
  process.exitCode = 1;
} finally {
  abortStreams.abort();
  for (const connection of connections) connection.terminate();
  service.kill('SIGTERM');
  if (service.exitCode === null) await Promise.race([once(service, 'exit'), delay(3000).then(() => service.kill('SIGKILL'))]);
  Object.assign(result, { endedAt: new Date().toISOString(), elapsedSeconds: Math.round((Date.now() - begin) / 1000), rounds, metrics });
  await mkdir('artifacts', { recursive: true });
  await writeFile(`artifacts/soak-${begin}.json`, JSON.stringify(result, null, 2));
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(result));
}
