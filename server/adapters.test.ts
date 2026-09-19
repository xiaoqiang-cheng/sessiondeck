import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { buildLaunch, discoverSessions, resolveNativeSessionId, validateNativeId } from './adapters.js';
import { DshBridge, dshDeepLinkClient } from './dsh.js';
import type { Session } from '../shared/types.js';

const makeSession = (patch: Partial<Session> = {}): Session => ({ id: randomUUID(), backend: 'codex', title: 'test', cwd: '/tmp', nativeSessionId: null, groupId: null, parentId: null, forkPending: false, status: 'idle', statusSource: 'process', statusDetail: '', lastActivity: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, pinned: false, unread: 0, running: false, origin: 'created', ...patch });

test('native launch uses argument arrays, preserves fork source, rejects option injection', async () => {
  const saved = { codex: process.env.SESSIONDECK_CODEX_BIN, claude: process.env.SESSIONDECK_CLAUDE_BIN };
  process.env.SESSIONDECK_CODEX_BIN = process.execPath;
  process.env.SESSIONDECK_CLAUDE_BIN = process.execPath;
  try {
    const source = randomUUID();
    const fork = await buildLaunch(makeSession({ nativeSessionId: source, forkPending: true, cwd: '/tmp/path with spaces' }));
    assert.deepEqual(fork.args, ['fork', source, '--cd', '/tmp/path with spaces']);
    assert.equal(fork.nativeSessionId, undefined);
    const claude = await buildLaunch(makeSession({ backend: 'claude', nativeSessionId: source, forkPending: true, title: '$(touch /tmp/nope)' }));
    assert.deepEqual(claude.args.slice(0, 3), ['--resume', source, '--fork-session']);
    assert.notEqual(claude.nativeSessionId, source);
    assert.equal(claude.args.at(-1), '$(touch /tmp/nope)');
    await assert.rejects(buildLaunch(makeSession({ nativeSessionId: '--dangerously-bypass-approvals-and-sandbox' })), /无效/);
    assert.throws(() => validateNativeId('dsh', '../session-id'), /无效/);
    assert.throws(() => validateNativeId('dsh', `session-${'-'.repeat(36)}`), /无效/);
  } finally {
    for (const [backend, value] of Object.entries(saved)) { const key = `SESSIONDECK_${backend.toUpperCase()}_BIN`; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('discovery tolerates millisecond-only creation metadata and invalid native timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-discovery-schema-'));
  const db = new DatabaseSync(join(dir, 'state_6.sqlite'));
  try {
    db.exec('CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, created_at_ms INTEGER, updated_at INTEGER, updated_at_ms INTEGER)');
    const id = randomUUID(), timestamp = Date.now();
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(id, dir, 'Compatible metadata', timestamp, 1e25, null);
    const rows = await discoverSessions('codex', { codexHome: dir });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.nativeSessionId, id);
    assert.ok(Number.isFinite(Date.parse(rows[0]!.lastActivity)));
    assert.equal(await resolveNativeSessionId(makeSession({ cwd: dir }), new Date(timestamp).toISOString(), [], { codexHome: dir }), id);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('discovery reads heterogeneous native metadata and avoids ambiguous new-session binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-adapters-'));
  try {
    const codexHome = join(dir, 'codex'), claudeHome = join(dir, 'claude'), dshHome = join(dir, 'dsh');
    await Promise.all([mkdir(codexHome), mkdir(join(claudeHome, 'projects', 'project'), { recursive: true }), mkdir(join(dshHome, 'storages'), { recursive: true })]);
    const id = randomUUID(), second = randomUUID(), claudeId = randomUUID(), dshId = `session-${randomUUID()}`;
    const timestamp = Date.now();
    const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, name TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run(id, dir, 'original title', 'Renamed', Math.floor(timestamp / 1000), Math.floor(timestamp / 1000), 0);
    insert.run(randomUUID(), dir, 'archived', null, 1, 1, 1);
    await writeFile(join(claudeHome, 'projects', 'project', `${claudeId}.jsonl`), [JSON.stringify({type:'user',cwd:dir,timestamp:new Date(timestamp).toISOString(),message:{content:'First request'}}), JSON.stringify({type:'custom-title',customTitle:'Custom Claude title'})].join('\n'));
    await writeFile(join(dshHome, 'storages', 'session_projcache.json'), JSON.stringify({tables:{sessions:{[dshId]:{identity:{cwd:dir,createdAt:timestamp},rows:{title:{val:'DeepSeek title'},sessionListMetadata:{val:{lastPromptAt:timestamp}}}}}}}));
    const paths = {codexHome,claudeHome,dshHome};
    const rows = await discoverSessions(undefined,paths);
    assert.equal(rows.length,3);
    assert.equal(rows.find(row=>row.backend==='codex')?.title,'Renamed');
    assert.equal(rows.find(row=>row.backend==='claude')?.title,'Custom Claude title');
    assert.equal(rows.find(row=>row.backend==='dsh')?.nativeSessionId,dshId);
    assert.ok(rows.every(row=>!('createdAt' in row) && !('message' in row)));
    assert.equal(await resolveNativeSessionId(makeSession({cwd:dir}),new Date(timestamp).toISOString(),[],paths),id);
    insert.run(second,dir,'another session',null,Math.floor(timestamp/1000),Math.floor(timestamp/1000),0);
    assert.equal(await resolveNativeSessionId(makeSession({cwd:dir}),new Date(timestamp).toISOString(),[],paths),null);
    assert.equal(await resolveNativeSessionId(makeSession({cwd:dir}),new Date(timestamp).toISOString(),[second],paths),id);
    db.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('DSH native API uses precise identity and refuses fork cwd mismatch', async () => {
  const id=`session-${randomUUID()}`, child=`session-${randomUUID()}`;
  const calls: {method:string;payload:Record<string,unknown>}[]=[];
  let mismatch=false;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const message=JSON.parse(body);calls.push(message);
    let value:unknown={accepted:true};
    if(message.method==='session.create')value={sessionId:id};
    if(message.method==='session.fork')value={sessionId:child};
    if(message.method==='session.list')value={items:[{sessionId:id,cwd:'/tmp',running:true}]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:mismatch?'wrong':message.rpcId,result:{ok:true,value}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address==='object');
  const bridge=new DshBridge({port:address.port,manageProcess:false});
  try {
    const session=await bridge.createSession('/tmp','Local name');
    assert.equal(session.nativeSessionId,id);assert.ok(session.nativeUrl.endsWith(id));
    assert.ok(!calls.some(call=>call.method==='session.prompt'));
    await assert.rejects(bridge.forkSession(id,'/different'),/工作目录/);
    assert.ok(!calls.some(call=>call.method==='session.fork'));
    assert.equal((await bridge.forkSession(id,'/tmp')).nativeSessionId,child);
    await bridge.prompt(id,'group handoff');
    assert.deepEqual(calls.at(-1)?.payload,{sessionId:id,mode:'queue',content:[{type:'text',text:'group handoff'}]});
    await bridge.stopSession(id);assert.equal(calls.at(-1)?.method,'session.cancel');
    mismatch=true;await assert.rejects(bridge.openSession(id),/请求 ID/);
  } finally {bridge.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('DSH deep link waits for native session list and opens only the specified contact once', () => {
  const id=`session-${randomUUID()}`;let plugin: {apply:(ctx:unknown)=>void}|undefined;
  let change=()=>{};const opened:string[]=[];const state:{byId:Record<string,unknown>}={byId:{}};
  runInNewContext(dshDeepLinkClient('test-link'),{URLSearchParams,location:{search:`?sessiondeckSession=${id}`},window:{__ModuleLoader__:{load:({factory}:{factory:()=>typeof plugin})=>{plugin=factory();}}}});
  plugin!.apply({sessions:{list:{getSnapshot:()=>state,subscribe:(listener:()=>void)=>{change=listener;return()=>{};}},open:(value:string)=>opened.push(value)},effect:(effect:()=>unknown)=>effect()});
  assert.deepEqual(opened,[]);
  state.byId[id]={};change();change();assert.deepEqual(opened,[id]);
});

test('thousands of native logs return the newest 250 by modification time without blocking the event loop', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-large-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  const count = 2100;
  const idAt = (index: number) => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  await Promise.all([
    mkdir(join(codexHome, 'sessions', '2026', '09', '01'), { recursive: true }),
    ...Array.from({ length: 4 }, (_, index) => mkdir(join(claudeHome, 'projects', `project-${index}`), { recursive: true })),
  ]);
  const base = new Date('2026-01-01T00:00:00.000Z').valueOf();
  // The newest file is lexically first: taking the final filenames or stopping
  // after 1500 entries cannot accidentally satisfy this assertion.
  for (let batch = 0; batch < count; batch += 40) {
    await Promise.all(Array.from({ length: Math.min(40, count - batch) }, async (_, offset) => {
      const index = batch + offset, id = idAt(index), date = new Date(base + (count - index) * 1000);
      const codex = join(codexHome, 'sessions', '2026', '09', '01', `rollout-${id}.jsonl`);
      const claude = join(claudeHome, 'projects', `project-${index % 4}`, `${id}.jsonl`);
      await Promise.all([
        writeFile(codex, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, timestamp: date.toISOString() } }) + '\n'),
        writeFile(claude, JSON.stringify({ cwd: root, timestamp: date.toISOString(), customTitle: `Contact ${index}` }) + '\n'),
      ]);
      await Promise.all([utimes(codex, date, date), utimes(claude, date, date)]);
    }));
  }
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const started = performance.now();
  let rows;
  try {
    rows = await Promise.all([
      discoverSessions('codex', { codexHome }),
      discoverSessions('claude', { claudeHome }),
      // Concurrent refreshes reuse the in-flight scan, while preserving the
      // caller's own result array and the same newest-first ordering.
      discoverSessions('claude', { claudeHome }),
    ]);
  } finally { clearInterval(timer); }
  t.diagnostic(`Scanned ${count * 2} synthetic native logs in ${Math.round(performance.now() - started)} ms; event loop advanced ${ticks} times`);
  assert.ok(ticks > 0, 'Metadata discovery monopolized the event loop');
  const expected = Array.from({ length: 250 }, (_, index) => idAt(index));
  for (const list of rows) assert.deepEqual(list.map(row => row.nativeSessionId), expected);
  assert.notEqual(rows[1], rows[2]);
});

test('Claude discovery uses bounded log edges and metadata titles, rejecting malformed paths and symlinks', async t => {
  const home = await mkdtemp(join(tmpdir(), 'deck-edge-discovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'projects', 'project');
  await mkdir(project, { recursive: true });
  const id = randomUUID(), unnamedId = randomUUID();
  const file = await open(join(project, `${id}.jsonl`), 'w');
  const size = 512 * 1024 * 1024;
  try {
    await file.write(JSON.stringify({ cwd: home, timestamp: new Date().toISOString() }) + '\n');
    await file.truncate(size);
    const tail = Buffer.from('\nnull\n' + JSON.stringify({ customTitle: 'Native\u001b title', message: { content: 'PRIVATE_MESSAGE_MUST_NOT_LEAVE' } }) + '\n{"partial":');
    await file.write(tail, 0, tail.length, size - tail.length);
  } finally { await file.close(); }
  await writeFile(join(project, `${unnamedId}.jsonl`), Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x0a]),
    Buffer.from(JSON.stringify({ cwd: home, type: 'user', message: { content: 'PRIVATE_MESSAGE_MUST_NOT_LEAVE' } }) + '\n'),
  ]));
  await writeFile(join(project, `${randomUUID()}.jsonl`), JSON.stringify({ cwd: '/bad\u0000path', customTitle: 'Invalid path' }));
  await writeFile(join(project, `${randomUUID()}.jsonl`), JSON.stringify({ cwd: 'relative/path', customTitle: 'Relative path' }));
  await writeFile(join(project, `${randomUUID()}.jsonl`), JSON.stringify({ cwd: '/' + 'a'.repeat(5000), customTitle: 'Oversized path' }));
  await symlink(join(project, `${id}.jsonl`), join(project, `${randomUUID()}.jsonl`));
  const rows = await discoverSessions('claude', { claudeHome: home });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.nativeSessionId === id)?.title, 'Native  title');
  assert.equal(rows.find(row => row.nativeSessionId === unnamedId)?.title, 'Claude Code 会话');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_MESSAGE_MUST_NOT_LEAVE'));
});

test('Codex discovery accepts current millisecond columns without legacy title or seconds fields', async t => {
  const home = await mkdtemp(join(tmpdir(), 'deck-new-schema-discovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'state_99.sqlite'));
  const id = randomUUID();
  try {
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, name TEXT, updated_at_ms INTEGER)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, home, 'New schema title', Date.now());
  } finally { db.close(); }
  const rows = await discoverSessions('codex', { codexHome: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.nativeSessionId, id);
  assert.equal(rows[0]?.title, 'New schema title');
});

test('one damaged dsh cache row cannot hide healthy metadata, and oversized caches are skipped', async t => {
  const home = await mkdtemp(join(tmpdir(), 'deck-dsh-cache-discovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'storages'));
  const path = join(home, 'storages', 'session_projcache.json'), id = `session-${randomUUID()}`;
  await writeFile(path, JSON.stringify({ tables: { sessions: {
    [`session-${randomUUID()}`]: null,
    [`session-${randomUUID()}`]: { identity: { cwd: ['invalid'] } },
    [id]: { identity: { cwd: home, createdAt: Date.now() }, rows: { title: { val: 'Healthy contact' }, sessionListMetadata: { val: null } } },
  } } }));
  assert.deepEqual((await discoverSessions('dsh', { dshHome: home })).map(row => row.nativeSessionId), [id]);
  const file = await open(path, 'w');
  try { await file.truncate(17 * 1024 * 1024); } finally { await file.close(); }
  assert.deepEqual(await discoverSessions('dsh', { dshHome: home }), []);
});
