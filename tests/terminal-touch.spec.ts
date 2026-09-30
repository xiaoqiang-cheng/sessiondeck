import { test } from './fixtures';
import { expect, type BrowserContext, type Page } from '@playwright/test';

async function drag(context: BrowserContext, page: Page, steps = 8, stepPx = 30) {
  const box = (await page.locator('.xterm-screen').boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const x = box.x + box.width / 2, y0 = box.y + 40;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let step = 1; step <= steps; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + step * stepPx }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const sliderTop = (page: Page) => page.evaluate(() => parseFloat(document.querySelector<HTMLElement>('.xterm-scrollable-element .scrollbar.vertical .slider')!.style.top));

test('a finger drag scrolls the terminal history and reports wheel to a mouse-tracking app', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const sent: string[] = [];
  page.on('websocket', socket => { if (socket.url().includes('/api/terminal/')) socket.on('framesent', ({ payload }) => { try { const m = JSON.parse(String(payload)); if (m.type === 'input') sent.push(m.data); } catch { /* non-JSON */ } }); });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '进入 SessionDeck · 开发笔记 的会话', exact: true }).click();
    await expect(page.locator('.terminal-connection')).toHaveText('已连接');
    // Fill the scrollback: every Enter makes the demo PTY echo a line.
    const textarea = page.locator('.xterm-helper-textarea');
    for (let index = 0; index < 60; index++) await textarea.press('Enter');
    await expect.poll(() => sliderTop(page)).toBeGreaterThan(100);
    const atBottom = await sliderTop(page);
    // Finger down → history scrolls up → the scrollbar slider moves up.
    await drag(context, page);
    await expect.poll(() => sliderTop(page)).toBeLessThan(atBottom - 20);
    expect(sent.some(data => data.includes('\x1b[M'))).toBe(false);

    // Under mouse tracking (the demo PTY echoes the enabling sequence, as
    // Claude Code emits it for real) rows are handed to xterm as wheel events
    // on its screen so the app receives them; nothing scrolls locally.
    const composer = page.getByLabel('终端输入栏');
    await composer.fill('\x1b[?1003h');
    await composer.press('Enter');
    await expect.poll(() => page.evaluate(() => document.querySelector('.xterm')!.className)).toContain('enable-mouse-events');
    await page.evaluate(() => { const w = window as unknown as { wheels: number[] }; w.wheels = []; document.querySelector('.xterm-screen')!.addEventListener('wheel', event => w.wheels.push((event as WheelEvent).deltaY)); });
    const slider = await sliderTop(page);
    await drag(context, page, 4, 30);
    await expect.poll(() => page.evaluate(() => (window as unknown as { wheels: number[] }).wheels.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { wheels: number[] }).wheels.every(dy => dy < 0 && Number.isInteger(dy)))).toBe(true);
    expect(await sliderTop(page)).toBe(slider);
  } finally { await context.close(); }
});
