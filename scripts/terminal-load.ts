import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.ts';
import { Terminals } from '../server/terminal.ts';

// Exercise high-volume native PTY output, ANSI state serialization, repeated
// reconnect snapshots, and resize/reflow without starting an agent or model.
const minutes = Number(process.argv.find(argument => argument.startsWith('--minutes='))?.split('=')[1] ?? 3);
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error('--minutes 必须在 0–60 之间');
const store = new Store(':memory:');
const terminals = new Terminals();
const session = store.addSession({ backend: 'codex', title: 'Terminal load fixture', cwd: process.cwd() });
const started = Date.now();
let bytes = 0;
let unexpectedExit: number | undefined;
let intentionalStop = false;
let sampleNumber = 0;
const metrics: { seconds: number; receivedMiB: number; rssMiB: number; heapMiB: number; snapshotKiB: number }[] = [];
terminals.on('data', (_id: string, data: string) => { bytes += Buffer.byteLength(data); });
terminals.on('exit', (_id: string, code: number) => { if (!intentionalStop) unexpectedExit = code; });
const emitter = `
  let sequence = 0;
  const line = '会话输出 αβ🙂 ' + 'x'.repeat(130);
  function output() {
    const block = Array.from({ length: 64 }, () => '\\x1b[32mROW-' + (++sequence) + '\\x1b[0m ' + line + '\\r\\n').join('');
    if (process.stdout.write(block)) setTimeout(output, 20);
    else process.stdout.once('drain', () => setTimeout(output, 20));
  }
  output();
`;
const report: Record<string, unknown> = { mode: 'isolated-pty-no-model', requestedMinutes: minutes, startedAt: new Date(started).toISOString(), passed: false };
try {
  terminals.start(session, { file: process.execPath, args: ['-e', emitter] });
  while (Date.now() - started < minutes * 60_000) {
    await delay(Math.min(5000, Math.max(1, minutes * 60_000 - (Date.now() - started))));
    assert.equal(unexpectedExit, undefined, 'PTY exited during sustained output');
    const cols = [100, 180, 45, 120][sampleNumber++ % 4];
    terminals.resize(session.id, cols, 32);
    const snapshot = terminals.buffer(session.id);
    assert.ok(snapshot.includes('ROW-'), 'reconnection snapshot lost all current output');
    // Bound follows the 1000-row replay window even after hundreds of MB.
    assert.ok(snapshot.length < 2_000_000, 'terminal snapshot grew without a bound');
    const memory = process.memoryUsage();
    const metric = {
      seconds: Math.round((Date.now() - started) / 1000), receivedMiB: Math.round(bytes / 1_048_576),
      rssMiB: Math.round(memory.rss / 1_048_576), heapMiB: Math.round(memory.heapUsed / 1_048_576),
      snapshotKiB: Math.round(Buffer.byteLength(snapshot) / 1024),
    };
    metrics.push(metric);
    if (sampleNumber % 6 === 1) console.log(JSON.stringify(metric));
  }
  intentionalStop = true;
  await terminals.stop(session.id);
  assert.match(terminals.buffer(session.id), /进程已退出/);
  assert.ok(bytes > 64_000, 'fixture did not produce substantial output');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  intentionalStop = true;
  try { await terminals.close(); }
  catch (error) { report.passed = false; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
  finally { store.close(); }
  Object.assign(report, { elapsedSeconds: Math.round((Date.now() - started) / 1000), receivedBytes: bytes, metrics });
  await mkdir('artifacts', { recursive: true });
  const path = `artifacts/terminal-load-${started}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, metrics: undefined, report: path }));
}
