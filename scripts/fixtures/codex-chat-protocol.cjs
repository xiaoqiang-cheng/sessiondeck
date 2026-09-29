#!/usr/bin/env node
// Native wire protocol fixture only. No model provider or credentials are used.
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocket, WebSocketServer } = require(process.env.SESSIONDECK_FIXTURE_WS);
const args = process.argv.slice(2), dir = process.env.SESSIONDECK_FIXTURE_DIR;
const log = value => fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(value) + '\n');
if (args.includes('--version')) { console.log('codex-fixture 0.158.0'); process.exit(0); }
if (args.includes('--help')) { console.log(args[0] === 'app-server' ? '--ws-auth --ws-token-file --listen' : 'resume fork --remote-auth-token-env'); process.exit(0); }
if (args[0] !== 'app-server') {
  if (!args.includes('--remote')) throw new Error('Unexpected fixture command');
  const id = args[args.indexOf('resume') + 1];
  log({ event: 'tui', nativeId: id });
  const socket = new WebSocket(args[args.indexOf('--remote') + 1], { headers: { Authorization: 'Bearer ' + process.env.SESSIONDECK_CODEX_TOKEN } });
  socket.on('error', () => process.exit(1));
  socket.on('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fixture-tui', version: '1' } } }));
    socket.send(JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: id } }));
    console.log('Chat fixture TUI ready ' + id);
  });
  process.stdin.resume();
} else {
  const endpoint = new URL(args[args.indexOf('--listen') + 1]);
  const token = fs.readFileSync(args[args.indexOf('--ws-token-file') + 1], 'utf8');
  const server = http.createServer((_req, response) => response.end('ready'));
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set(), threads = new Map(), pending = new Map();
  const send = (socket, value) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const emit = (id, method, params) => { for (const socket of sockets) if (socket.threadId === id) send(socket, { method, params: { threadId: id, ...params } }); };
  const complete = (thread, text = 'Local fixture answer') => {
    const turn = thread.turns.at(-1);
    if (!turn || turn.status !== 'inProgress') return;
    const item = { id: crypto.randomUUID(), type: 'agentMessage', text: '', phase: 'final_answer' };
    turn.items.push(item);
    emit(thread.id, 'item/started', { turnId: turn.id, item: { ...item } });
    item.text = text;
    emit(thread.id, 'item/agentMessage/delta', { turnId: turn.id, itemId: item.id, delta: text });
    emit(thread.id, 'item/completed', { turnId: turn.id, item: { ...item } });
    turn.status = 'completed'; thread.status = { type: 'idle' };
    emit(thread.id, 'turn/completed', { turn });
  };
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== 'Bearer ' + token) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      const message = JSON.parse(String(raw)), params = message.params || {};
      if (!message.method) {
        log({ event: 'answer', id: message.id, result: message.result, error: message.error, client: socket.clientName });
        const request = pending.get(String(message.id));
        if (request) { pending.delete(String(message.id)); complete(request.thread, 'Approval handled: ' + JSON.stringify(message.result)); }
        return;
      }
      log({ method: message.method, params, client: socket.clientName });
      if (message.id === undefined) return;
      let result = {}, thread;
      if (message.method === 'initialize') socket.clientName = params.clientInfo?.name;
      else if (message.method === 'thread/start') {
        thread = { id: crypto.randomUUID(), cwd: params.cwd, status: { type: 'idle' }, turns: [], forkedFromId: null, canAcceptDirectInput: true };
        threads.set(thread.id, thread); socket.threadId = thread.id; result = { thread };
      } else if (message.method === 'thread/resume' || message.method === 'thread/read') {
        thread = threads.get(params.threadId);
        if (!thread) { send(socket, { id: message.id, error: { code: -1, message: 'Unknown fixture thread' } }); return; }
        if (message.method === 'thread/resume') socket.threadId = thread.id;
        result = { thread };
      } else if (message.method === 'thread/name/set') {
        thread = threads.get(params.threadId); if (thread) thread.name = params.name;
      } else if (message.method === 'thread/turns/list') {
        thread = threads.get(params.threadId); result = { data: thread?.turns ?? [], nextCursor: null };
      } else if (message.method === 'thread/fork') {
        const parent = threads.get(params.threadId);
        thread = structuredClone(parent); thread.id = crypto.randomUUID(); thread.cwd = params.cwd || parent.cwd; thread.forkedFromId = parent.id; thread.status = { type: 'idle' };
        threads.set(thread.id, thread); socket.threadId = thread.id; result = { thread };
      } else if (message.method === 'turn/start') {
        thread = threads.get(params.threadId); socket.threadId = thread.id;
        const input = params.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
        const turn = { id: crypto.randomUUID(), status: 'inProgress', items: [{ id: crypto.randomUUID(), type: 'userMessage', content: [{ type: 'text', text: input, text_elements: [] }] }] };
        thread.turns.push(turn); thread.status = { type: 'active', activeFlags: [] };
        emit(thread.id, 'turn/started', { turn });
        emit(thread.id, 'item/completed', { turnId: turn.id, item: turn.items[0] });
        if (input.includes('DROP_RESPONSE')) { socket.close(); return; }
        result = { turn };
        if (input.includes('APPROVAL')) {
          const item = { id: crypto.randomUUID(), type: 'commandExecution', command: 'printf fixture', cwd: thread.cwd, status: 'inProgress', commandActions: [], aggregatedOutput: '' };
          turn.items.push(item); emit(thread.id, 'item/started', { turnId: turn.id, item });
          const id = 'approval-' + crypto.randomUUID(); pending.set(id, { thread });
          setTimeout(() => send(socket, { id, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, itemId: item.id, command: item.command, cwd: thread.cwd, reason: 'Harmless local protocol approval', availableDecisions: ['accept', 'decline', 'cancel'] } }), 10);
        } else if (input.includes('QUESTION')) {
          const id = 'question-' + crypto.randomUUID(); pending.set(id, { thread });
          setTimeout(() => send(socket, { id, method: 'item/tool/requestUserInput', params: { threadId: thread.id, turnId: turn.id, itemId: crypto.randomUUID(), questions: [{ id: 'choice', header: 'Choose', question: 'Which option?', isOther: false, isSecret: false, options: [{ label: 'One', description: 'First option' }, { label: 'Two', description: 'Second option' }] }] } }), 10);
        } else if (!input.includes('HOLD')) setTimeout(() => complete(thread, 'Reply: ' + input), 40);
      } else if (message.method === 'turn/interrupt') {
        thread = threads.get(params.threadId); const turn = thread?.turns.at(-1);
        if (!turn || turn.id !== params.turnId) { send(socket, { id: message.id, error: { code: -1, message: 'Wrong turn' } }); return; }
        turn.status = 'interrupted'; thread.status = { type: 'idle' };
        for (const [id, request] of pending) if (request.thread === thread) pending.delete(id);
        emit(thread.id, 'turn/completed', { turn });
      }
      send(socket, { id: message.id, result });
    });
  });
  server.listen(Number(endpoint.port), '127.0.0.1');
  process.on('SIGTERM', () => { for (const socket of sockets) socket.terminate(); server.close(() => process.exit(0)); });
}
