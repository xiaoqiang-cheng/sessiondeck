import { useState } from 'react';
import type { Backend, SessionStatus } from '../shared/types';
import type { View } from './navigation';
import { readLocalPreference, writeLocalPreference } from './ui';

export type ContactSort = 'activity' | 'name' | 'created';
type ContactFilters = { query: string; backend: Backend | 'all'; status: SessionStatus | 'attention' | 'unread' | 'all' };
const defaults: ContactFilters = { query: '', backend: 'all', status: 'all' };
const statuses = new Set(['all', 'attention', 'unread', 'idle', 'running', 'waiting_input', 'waiting_approval', 'error', 'stopped', 'unknown']);

function readFilters(view: View): ContactFilters {
  try {
    const saved = JSON.parse(readLocalPreference(`sessiondeck.filters.${view}`) ?? 'null');
    return {
      query: typeof saved?.query === 'string' ? saved.query.slice(0, 300) : '',
      backend: ['all', 'claude', 'codex', 'dsh'].includes(saved?.backend) ? saved.backend : 'all',
      status: statuses.has(saved?.status) ? saved.status : 'all',
    };
  } catch { return { ...defaults }; }
}

/** Each view remembers its own filters without leaking them into other groups. */
export function useContactFilters(view: View) {
  const [snapshot, setSnapshot] = useState(() => ({ view, filters: readFilters(view) }));
  const filters = snapshot.view === view ? snapshot.filters : readFilters(view);
  const update = (patch: Partial<ContactFilters>) => {
    const next = { ...filters, ...patch };
    writeLocalPreference(`sessiondeck.filters.${view}`, JSON.stringify(next));
    setSnapshot({ view, filters: next });
  };
  return {
    query: filters.query, backendFilter: filters.backend, statusFilter: filters.status,
    setQuery: (query: string) => update({ query }),
    setBackendFilter: (backend: Backend | 'all') => update({ backend }),
    setStatusFilter: (status: ContactFilters['status']) => update({ status }),
    clearFilters: () => update(defaults),
  };
}

export function useContactSort() {
  const [sort, setSort] = useState<ContactSort>(() => {
    const saved = readLocalPreference('sessiondeck.contact-sort');
    return saved === 'name' || saved === 'activity' ? saved : 'created';
  });
  return [sort, (next: ContactSort) => { writeLocalPreference('sessiondeck.contact-sort', next); setSort(next); }] as const;
}
