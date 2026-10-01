import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeStatusWatcher, codexStatusEvent, dshStatusEvent, type NativeStatusEvent } from './native-status.js';
import { zstdCompressSync } from 'node:zlib';
import type { Session } from '../shared/types.js';

test('only native lifecycle envelopes can drive Codex state, never conversation text', () => {
  assert.equal(codexStatusEvent({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'task_started'}}),null);
  assert.equal(codexStatusEvent({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'agent_message',message:'task_complete waiting_approval'}}),null);
  assert.equal(codexStatusEvent({type:'event_msg',payload:{type:'task_started'}}),null);
  const event=codexStatusEvent({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'exec_approval_request',command:'private command'}});
  assert.equal(event?.status,'waiting_approval');assert.ok(!JSON.stringify(event).includes('private command'));
});

test('observer ignores old turns, preserves ID discovery boundary, handles split appended lines and stops', async () => {
  const home=await mkdtemp(join(tmpdir(),'deck-native-status-'));const id=randomUUID();const card=randomUUID();const path=join(home,'rollout.jsonl');
  const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT, history_mode TEXT)');db.prepare('INSERT INTO threads VALUES(?,?,?)').run(id,path,'paginated');db.close();
  const envelope=(type:string,timestamp=new Date().toISOString())=>JSON.stringify({type:'event_msg',timestamp,payload:{type}})+'\n';
  await writeFile(path,envelope('task_complete',new Date(Date.now()-60_000).toISOString()));
  const watcher=new NativeStatusWatcher({codexHome:home,intervalMs:25});const received:NativeStatusEvent[]=[];
  const session={id:card,backend:'codex',nativeSessionId:null,forkPending:false} as Session;
  const waitFor=async(count:number)=>{for(let i=0;i<80&&received.length<count;i++)await delay(25);assert.equal(received.length,count);};
  try{
    watcher.start(session,event=>received.push(event));
    await appendFile(path,envelope('task_started'));
    watcher.start({...session,nativeSessionId:id},event=>received.push(event));
    await waitFor(1);assert.equal(received[0]?.status,'running');
    const done=envelope('task_complete');await appendFile(path,done.slice(0,-4));await delay(100);assert.equal(received.length,1);
    await appendFile(path,done.slice(-4));await waitFor(2);assert.equal(received[1]?.status,'waiting_input');
    watcher.stop(card);await appendFile(path,envelope('task_started'));await delay(100);assert.equal(received.length,2);
  }finally{watcher.close();await rm(home,{recursive:true,force:true});}
});

test('dsh lifecycle rows drive state; the compressed log is observed by frame and old turns stay out', async () => {
  assert.equal(dshStatusEvent({ type: 'turn/start', seq: 1, time: 1_790_000_000_000 })?.status, 'running');
  assert.equal(dshStatusEvent({ type: 'turn/end', seq: 2, time: 1_790_000_000_001, data: { turn: 1, reason: { kind: 'completed' } } })?.status, 'waiting_input');
  assert.equal(dshStatusEvent({ type: 'turn/end', seq: 2, time: 1_790_000_000_001, data: { reason: { kind: 'error' } } })?.status, 'error');
  assert.equal(dshStatusEvent({ type: 'approval/request', seq: 3, time: 1_790_000_000_002 })?.status, 'waiting_approval');
  assert.equal(dshStatusEvent({ type: 'assistant/message', seq: 4, time: 1_790_000_000_003, data: { message: { content: [{ type: 'text', text: 'turn/end' }] } } }), null);
  assert.equal(dshStatusEvent({ type: 'turn/start', seq: 5, time: 'yesterday' }), null);

  const home = await mkdtemp(join(tmpdir(), 'deck-dsh-status-')); const id = randomUUID(); const card = randomUUID();
  const folder = join(home, 'sessions', '--work--', id); const path = join(folder, 'session.v4.jsonl.zstd');
  const frame = (type: string, time: number, data?: unknown) => zstdCompressSync(Buffer.from(JSON.stringify({ type, seq: time, time, data }) + '\n'));
  await writeFile(join(home, 'placeholder'), '');
  await (await import('node:fs/promises')).mkdir(folder, { recursive: true });
  // An old completed turn precedes the launch boundary and must never replay.
  await writeFile(path, frame('turn/end', Date.now() - 60_000, { reason: { kind: 'completed' } }));
  const watcher = new NativeStatusWatcher({ dshHome: home, intervalMs: 25 }); const received: NativeStatusEvent[] = [];
  const session = { id: card, backend: 'dsh', nativeSessionId: id, forkPending: false } as Session;
  const waitFor = async (count: number) => { for (let i = 0; i < 80 && received.length < count; i++) await delay(25); assert.equal(received.length, count); };
  try {
    watcher.start(session, event => received.push(event));
    await delay(150); assert.equal(received.length, 0);
    await appendFile(path, frame('turn/start', Date.now()));
    await waitFor(1); assert.equal(received[0]?.status, 'running');
    await appendFile(path, frame('turn/end', Date.now(), { reason: { kind: 'completed' } }));
    await waitFor(2); assert.equal(received[1]?.status, 'waiting_input');
    watcher.stop(card); await appendFile(path, frame('turn/start', Date.now())); await delay(100); assert.equal(received.length, 2);
  } finally { watcher.close(); await rm(home, { recursive: true, force: true }); }
});
