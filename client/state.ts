import type { AppState, StatePatch } from '../shared/types';

function upsert<T extends { id: string }>(previous: T[], updates?: T[]): T[] {
  if (!updates?.length) return previous;
  const result = new Map(previous.map(item => [item.id, item]));
  for (const item of updates) result.set(item.id, item);
  return [...result.values()];
}

/** null requests a fresh snapshot; obsolete patches preserve object identity. */
export function applyStatePatch(previous: AppState | null, patch: StatePatch): AppState | null {
  if (!previous || patch.instanceId !== previous.instanceId || typeof previous.revision !== 'number') return null;
  if (!Number.isSafeInteger(patch.revision) || !Number.isSafeInteger(patch.baseRevision) || patch.revision < patch.baseRevision) return null;
  if (patch.revision <= previous.revision) return previous;
  if (patch.baseRevision > previous.revision) return null;
  const activities = patch.activities ? upsert([...previous.activities].reverse(), patch.activities.upsert)
    .filter(item => !patch.activities!.remove.includes(item.id)).reverse().slice(0, 100) : previous.activities;
  return { ...previous, revision: patch.revision, sessions: upsert(previous.sessions, patch.sessions), groups: upsert(previous.groups, patch.groups), activities, backends: patch.backends ?? previous.backends };
}
