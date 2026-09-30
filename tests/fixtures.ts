import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { AppState } from '../shared/types';

/** Follow the actual test server, including a custom SESSIONDECK_TEST_PORT. */
export async function mutationHeaders(request: APIRequestContext) {
  const response = await request.get('/api/config');
  expect(response.ok(), 'read CSRF configuration from the isolated test server').toBeTruthy();
  const { csrfToken } = await response.json();
  return { 'X-SessionDeck-Token': csrfToken as string, Origin: new URL(response.url()).origin };
}

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
    const headers = await mutationHeaders(request);
    for (const session of ownedProcesses) {
      const response = await request.post(`/api/sessions/${session.id}/stop`, { data: {}, headers });
      expect(response.ok(), `stop the demo process owned by this test: ${session.title}`).toBeTruthy();
    }
  }, { auto: true }],
});
