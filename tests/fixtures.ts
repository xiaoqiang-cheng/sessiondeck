import { test as base, expect } from '@playwright/test';
import type { AppState } from '../shared/types';

/** Tests share a seeded demo server, but every test owns and cleans its PTYs. */
export const test = base.extend<{ demoProcessCleanup: void }>({
  demoProcessCleanup: [async ({ request }, use) => {
    const before = await (await request.get('/api/state')).json() as AppState;
    expect(before.demo, 'browser regression tests must never start real model backends').toBe(true);
    const existing = new Set(before.sessions.map(session => session.id));
    await use();
    const after = await (await request.get('/api/state')).json() as AppState;
    const ownedProcesses = after.sessions.filter(session => !existing.has(session.id) && session.running);
    if (!ownedProcesses.length) return;
    const { csrfToken } = await (await request.get('/api/config')).json();
    for (const session of ownedProcesses) {
      const response = await request.post(`/api/sessions/${session.id}/stop`, { data: {}, headers: { 'X-SessionDeck-Token': csrfToken, Origin: 'http://127.0.0.1:4337' } });
      expect(response.ok(), `stop the demo process owned by this test: ${session.title}`).toBeTruthy();
    }
  }, { auto: true }],
});
