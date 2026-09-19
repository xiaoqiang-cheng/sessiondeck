import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import type { AppState, Session } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const wsModule = require.resolve('ws');

async function freePort() {
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => probe.close(() => accept()));
  return address.port;
}
async function until(check: () => Promise<boolean>, description: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error(description);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  const kill = setTimeout(() => child.kill('SIGKILL'), 2500);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(kill); }
}

/** A local protocol fixture, not a model emulator. It exercises the real API,
 * authenticated bridge, and PTY integration without native credentials. */
function fixtureSource() {
  return `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
const {WebSocket,WebSocketServer}=require(${JSON.stringify(wsModule)});
const args=process.argv.slice(2),dir=process.env.SESSIONDECK_FIXTURE_DIR;
const log=x=>fs.appendFileSync(dir+'/calls.jsonl',JSON.stringify(x)+'\\n');
if(args.includes('--version')){console.log('codex-fixture 0.154.0');process.exit(0)}
if(args.includes('--help')){console.log(process.env.SESSIONDECK_FIXTURE_LEGACY==='1'?'resume fork':args[0]==='app-server'?'--ws-auth --ws-token-file --listen':'resume fork --remote-auth-token-env');process.exit(0)}
if(args[0]==='app-server'){
 const url=new URL(args[args.indexOf('--listen')+1]);
 const token=fs.readFileSync(args[args.indexOf('--ws-token-file')+1],'utf8');
 const threads=new Map(),server=http.createServer((req,res)=>{res.end('ready')});
 const sockets=new Set();const wss=new WebSocketServer({noServer:true});
 server.on('upgrade',(req,socket,head)=>{if(req.headers.authorization!=='Bearer '+token){socket.end('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');return}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req))});
 const emit=(id,method,params)=>{for(const s of sockets)if(s.threadId===id&&s.readyState===WebSocket.OPEN)s.send(JSON.stringify({method,params}))};
 wss.on('connection',s=>{sockets.add(s);s.on('close',()=>{log({event:'close',threadId:s.threadId||null});sockets.delete(s)});s.on('message',raw=>{
  const m=JSON.parse(String(raw)),p=m.params||{};if(!m.method)return;
  log({method:m.method,params:p,client:s.clientName});if(m.id===undefined)return;
  let result={},thread;
  if(m.method==='initialize'){s.clientName=p.clientInfo?.name;result={}}
  else if(m.method==='thread/start'){thread={id:crypto.randomUUID(),cwd:p.cwd,status:{type:'idle'},forkedFromId:null,turns:[]};threads.set(thread.id,thread);s.threadId=thread.id;result={thread};if(fs.existsSync(dir+'/fail-next-pty')){fs.unlinkSync(dir+'/fail-next-pty');fs.unlinkSync(__filename)}}
  else if(m.method==='thread/read'||m.method==='thread/resume'){thread=threads.get(p.threadId);if(!thread){s.send(JSON.stringify({id:m.id,error:{code:-1,message:'missing thread'}}));return}if(m.method==='thread/resume')s.threadId=thread.id;result={thread}}
  else if(m.method==='thread/name/set'){thread=threads.get(p.threadId);if(thread)thread.name=p.name}
  else if(m.method==='thread/fork'){const parent=threads.get(p.threadId);thread={...parent,id:crypto.randomUUID(),cwd:p.cwd||parent.cwd,forkedFromId:parent.id,status:{type:'idle'},turns:[]};threads.set(thread.id,thread);s.threadId=thread.id;result={thread}}
  else if(m.method==='fixture/start'){thread=threads.get(p.threadId);thread.status={type:'active',activeFlags:[]};thread.turns=[{id:crypto.randomUUID(),status:'inProgress'}];emit(thread.id,'turn/started',{threadId:thread.id,turn:thread.turns[0]})}
  else if(m.method==='fixture/complete'){thread=threads.get(p.threadId);thread.status={type:'idle'};thread.turns[0].status=p.status||'completed';emit(thread.id,'turn/completed',{threadId:thread.id,turn:thread.turns[0]})}
  else if(m.method==='fixture/dropObserver'){for(const observer of sockets)if(observer.threadId===p.threadId&&observer.clientName==='sessiondeck')observer.close()}
  else if(m.method==='turn/interrupt'){thread=threads.get(p.threadId);if(!thread||thread.turns[0]?.id!==p.turnId){s.send(JSON.stringify({id:m.id,error:{code:-1,message:'wrong turn'}}));return}thread.status={type:'idle'};thread.turns[0].status='interrupted';emit(thread.id,'turn/completed',{threadId:thread.id,turn:thread.turns[0]})}
  s.send(JSON.stringify({id:m.id,result}));
 })});server.listen(Number(url.port),'127.0.0.1');process.on('SIGTERM',()=>{for(const s of sockets)s.terminate();server.close(()=>process.exit(0))});
}else if(args.includes('--remote')){
 const id=args[args.indexOf('resume')+1],url=args[args.indexOf('--remote')+1];
 log({event:'tui',nativeId:id,authPresent:!!process.env.SESSIONDECK_CODEX_TOKEN,args:args.filter((a,i)=>i!==args.indexOf('--remote')+1)});
 const ws=new WebSocket(url,{headers:{Authorization:'Bearer '+process.env.SESSIONDECK_CODEX_TOKEN}});let next=1;
 ws.on('open',()=>{ws.send(JSON.stringify({id:next++,method:'initialize',params:{clientInfo:{name:'fixture-tui',version:'0'}}}));ws.send(JSON.stringify({id:next++,method:'thread/resume',params:{threadId:id}}));console.log('TUI ready '+id)});ws.on('error',()=>process.exit(1));
 process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{if(text.includes('start-work'))ws.send(JSON.stringify({id:next++,method:'fixture/start',params:{threadId:id}}));if(text.includes('complete-work'))ws.send(JSON.stringify({id:next++,method:'fixture/complete',params:{threadId:id}}));if(text.includes('fail-work'))ws.send(JSON.stringify({id:next++,method:'fixture/complete',params:{threadId:id,status:'failed'}}));if(text.includes('drop-observer'))ws.send(JSON.stringify({id:next++,method:'fixture/dropObserver',params:{threadId:id}}));if(text.includes('exit-now'))process.exit(4)});
}else{log({event:'legacy',args});console.log('legacy TUI ready');setInterval(()=>{},1000)}
`;
}

async function launchFixture(t: test.TestContext, legacy = false) {
  const dir = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-api-'));
  const file = join(dir, 'codex-fixture.cjs');
  const source = fixtureSource();
  await writeFile(file, source, { mode: 0o700 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: resolve('.'),
    env: { ...process.env, PORT: String(port), SESSIONDECK_PORT: String(port), SESSIONDECK_DEMO: '0', SESSIONDECK_DATA_DIR: join(dir, 'data'), SESSIONDECK_CODEX_PORT: '0', SESSIONDECK_CODEX_BIN: file, SESSIONDECK_CLAUDE_BIN: '/missing-claude-fixture', SESSIONDECK_DSH_BIN: '/missing-dsh-fixture', SESSIONDECK_FIXTURE_DIR: dir, SESSIONDECK_FIXTURE_LEGACY: legacy ? '1' : '0', CODEX_HOME: join(dir, 'codex-home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout?.on('data', value => { logs = (logs + value).slice(-8000); }); child.stderr?.on('data', value => { logs = (logs + value).slice(-8000); });
  const sockets = new Set<WebSocket>();
  t.after(async () => { for (const socket of sockets) socket.terminate(); await stop(child); await rm(dir, { recursive: true, force: true }); });
  await until(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(`${base}/api/config`)).ok; } catch { return false; } }, 'Codex API fixture did not start');
  const { csrfToken } = await (await fetch(`${base}/api/config`)).json() as { csrfToken: string };
  const request = async <T>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-sessiondeck-token': csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result as T;
  };
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { method?: string; event?: string; nativeId?: string; threadId?: string; client?: string; params?: Record<string, unknown>; args?: string[] });
  const terminal = async (id: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${id}?token=${csrfToken}`, { origin: base }); sockets.add(socket);
    const output = { socket, text: '' }; socket.on('message', raw => { const event = JSON.parse(raw.toString()); if (event.type === 'data') output.text += event.data ?? ''; });
    await new Promise<void>((accept, reject) => { socket.once('open', accept); socket.once('error', reject); }); return output;
  };
  return { dir, file, source, request, calls, terminal };
}

test('Codex HTTP lifecycle retains exact native identity across PTY failure, Fork, stop and resume', { timeout: 30_000 }, async t => {
  const fixture = await launchFixture(t); const { request, calls } = fixture;
  const state = () => request<AppState>('/api/state');
  assert.equal((await state()).backends.find(backend => backend.id === 'codex')?.capabilities.nativeControl, true);
  const source = await request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Contract source', cwd: fixture.dir }, 201);
  const current = async () => (await state()).sessions.find(item => item.id === source.id)!;
  await writeFile(join(fixture.dir, 'fail-next-pty'), '1');
  // node-pty may report a missing executable asynchronously through onExit.
  await request(`/api/sessions/${source.id}/start`, 'POST', {});
  await until(async () => !(await current()).running, 'Failed PTY did not report its exit');
  const afterFailure = await current(); assert.ok(afterFailure.nativeSessionId); assert.equal(afterFailure.running, false);
  await writeFile(fixture.file, fixture.source, { mode: 0o700 });
  const restarted = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', {});
  assert.equal(restarted.nativeSessionId, afterFailure.nativeSessionId);
  assert.equal((await calls()).filter(call => call.method === 'thread/start').length, 1);
  await until(async () => (await calls()).some(call => call.event === 'tui' && call.nativeId === restarted.nativeSessionId), 'Native TUI did not resume the exact created ID');
  const child = await request<Session>(`/api/sessions/${source.id}/fork`, 'POST', { title: 'Contract child' }, 201);
  assert.notEqual(child.nativeSessionId, restarted.nativeSessionId); assert.equal(child.parentId, source.id); assert.equal(child.forkPending, false); assert.equal(child.running, false);
  const exposed = JSON.stringify(await state()); assert.equal(exposed.includes('remoteUrl'), false); assert.equal(exposed.includes('SESSIONDECK_CODEX_TOKEN'), false); assert.equal(exposed.includes('ws://127.0.0.1'), false);
  await request(`/api/sessions/${source.id}/stop`, 'POST', {});
  assert.equal((await current()).running, false);
  await request(`/api/sessions/${source.id}/start`, 'POST', {});
  assert.equal((await current()).nativeSessionId, restarted.nativeSessionId);
  assert.equal((await calls()).filter(call => call.method === 'thread/start').length, 1);
  await request(`/api/sessions/${source.id}/stop`, 'POST', {});
});

test('Codex TUI exit interrupts only its native thread and releases the observer before restart', { timeout: 30_000 }, async t => {
  const fixture = await launchFixture(t); const { request, calls, terminal } = fixture;
  const item = await request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Exited TUI', cwd: fixture.dir }, 201);
  await request(`/api/sessions/${item.id}/start`, 'POST', {});
  const current = async () => (await request<AppState>('/api/state')).sessions.find(row => row.id === item.id)!;
  const started = await current(); const connection = await terminal(item.id);
  await until(async () => connection.text.includes('TUI ready'), 'TUI did not start');
  connection.socket.send(JSON.stringify({ type: 'input', data: 'start-work\r' }));
  await until(async () => (await current()).status === 'running', 'Native turn start was not received');
  connection.socket.send(JSON.stringify({ type: 'input', data: 'exit-now\r' }));
  await until(async () => (await calls()).some(call => call.method === 'turn/interrupt'), 'TUI exit did not interrupt native turn');
  await until(async () => (await calls()).filter(call => call.event === 'close' && call.threadId === started.nativeSessionId).length >= 2, 'TUI and observer were not released');
  const interrupted = (await calls()).filter(call => call.method === 'turn/interrupt');
  assert.equal(interrupted.length, 1); assert.equal(interrupted[0].params?.threadId, started.nativeSessionId); assert.match(String(interrupted[0].params?.turnId), /^[a-f\d-]{36}$/i);
  await request(`/api/sessions/${item.id}/start`, 'POST', {});
  assert.equal((await current()).nativeSessionId, started.nativeSessionId);
  await request(`/api/sessions/${item.id}/stop`, 'POST', {});
});

test('Codex CLI without authenticated remote flags uses native terminal fallback', { timeout: 20_000 }, async t => {
  const fixture = await launchFixture(t, true);
  const state = await fixture.request<AppState>('/api/state'); assert.equal(state.backends.find(item => item.id === 'codex')?.capabilities.nativeControl, false);
  const item = await fixture.request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Older CLI', cwd: fixture.dir }, 201);
  await fixture.request(`/api/sessions/${item.id}/start`, 'POST', {});
  await until(async () => (await fixture.calls()).some(call => call.event === 'legacy'), 'Legacy terminal was not started');
  assert.ok(!(await fixture.calls()).some(call => call.method === 'thread/start'));
  assert.ok((await fixture.calls()).some(call => call.event === 'legacy' && call.args?.includes('--cd')));
  await fixture.request(`/api/sessions/${item.id}/stop`, 'POST', {});
});

test('Codex observer reconnect keeps a completed turn visible for human review', { timeout: 20_000 }, async t => {
  const fixture = await launchFixture(t); const { request, calls } = fixture;
  const item = await request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Needs review after reconnect', cwd: fixture.dir }, 201);
  await request(`/api/sessions/${item.id}/start`, 'POST', {});
  const current = async () => (await request<AppState>('/api/state')).sessions.find(row => row.id === item.id)!;
  const terminal = await fixture.terminal(item.id);
  await until(async () => terminal.text.includes('TUI ready'), 'Fixture TUI did not start');
  const send = (data: string) => terminal.socket.send(JSON.stringify({ type: 'input', data: data + '\r' }));
  send('start-work'); await until(async () => (await current()).status === 'running', 'Turn did not start');
  send('complete-work'); await until(async () => (await current()).status === 'waiting_input', 'Turn completion did not request review');
  assert.equal((await current()).unread, 1);
  await request(`/api/sessions/${item.id}/read`, 'POST', {});
  assert.equal((await current()).unread, 0);
  send('drop-observer'); await until(async () => (await current()).status === 'unknown', 'Observer disconnect did not become unknown');
  await until(async () => (await calls()).some(call => call.method === 'thread/resume' && call.client === 'sessiondeck') && (await current()).status !== 'unknown', 'Observer did not recover');
  assert.equal((await current()).status, 'waiting_input', 'A status-channel reconnect must not erase an unreviewed completed turn');
  assert.equal((await current()).unread, 0, 'Reconnecting must not create another unread notification for an acknowledged turn');
  await request(`/api/sessions/${item.id}/stop`, 'POST', {});
});

for (const [command, expectedStatus] of [['complete-work', 'waiting_input'], ['fail-work', 'error']] as const) {
  test(`Codex recovery discovers ${expectedStatus} when the turn ends during a status outage`, { timeout: 20_000 }, async t => {
    const fixture = await launchFixture(t); const { request } = fixture;
    const item = await request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Result during outage', cwd: fixture.dir }, 201);
    await request(`/api/sessions/${item.id}/start`, 'POST', {});
    const current = async () => (await request<AppState>('/api/state')).sessions.find(row => row.id === item.id)!;
    const terminal = await fixture.terminal(item.id);
    await until(async () => terminal.text.includes('TUI ready'), 'Fixture TUI did not start');
    const send = (data: string) => terminal.socket.send(JSON.stringify({ type: 'input', data: data + '\r' }));
    send('start-work'); await until(async () => (await current()).status === 'running', 'Turn did not start');
    send('drop-observer'); await until(async () => (await current()).status === 'unknown', 'Observer did not disconnect');
    send(command);
    await until(async () => (await current()).status === expectedStatus, 'Native turn result was not recovered after the observer outage');
    assert.equal((await current()).unread, 1, 'A result missed during the outage must create exactly one notification');
    await request(`/api/sessions/${item.id}/stop`, 'POST', {});
  });
}
