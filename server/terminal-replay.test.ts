import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import headless from '@xterm/headless';
import { TerminalReplay } from './terminal-replay.ts';

async function render(data: string, cols = 100, rows = 30) {
  const terminal = new headless.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  await new Promise<void>(accept => terminal.write(data, accept));
  const screen = Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
  const cursor = { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY };
  terminal.dispose();
  return { screen, cursor };
}

test('replay restores the current alternate screen after output exceeds the old raw suffix limit', async () => {
  const replay = new TerminalReplay();
  try {
    replay.write('Old scrollback\r\n' + 'long historical line\r\n'.repeat(20_000));
    replay.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[32mNative agent\x1b[0m\r\nActive prompt > ');
    for (let i = 0; replay.backlogged && i < 100; i++) await delay(10);
    await delay(30);
    const snapshot = replay.snapshot();
    assert.ok(snapshot.length < 150_000, 'Retained terminal state must stay bounded');
    const view = await render(snapshot);
    assert.match(view.screen, /Native agent\nActive prompt >/);
    assert.doesNotMatch(view.screen, /long historical line/);
    assert.equal(view.cursor.x, 'Active prompt > '.length);
  } finally { replay.close(); }
});

test('a snapshot taken before asynchronous parsing includes each pending write once', async () => {
  const replay = new TerminalReplay(40, 6);
  try {
    replay.write('first line\r\n');
    replay.write('second line');
    const initial = await render(replay.snapshot(), 40, 6);
    assert.equal(initial.screen.split('first line').length - 1, 1);
    assert.equal(initial.screen.split('second line').length - 1, 1);
    await delay(20);
    const settled = await render(replay.snapshot(), 40, 6);
    assert.equal(settled.screen, initial.screen);
  } finally { replay.close(); }
});
