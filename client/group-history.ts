import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupDetail, GroupMessage } from '../shared/types';
import { api } from './api';

function merge(previous: GroupDetail, page: GroupDetail, older = false): GroupDetail {
  const messages = new Map(previous.messages.map(message => [message.id, message]));
  for (const message of page.messages) {
    const existing = messages.get(message.id);
    // Changes to unloaded older messages must not create holes in the page.
    if (!older && !existing && previous.page?.before && (message.sequence ?? 0) < previous.page.before) continue;
    if (!existing || (message.revision ?? 0) >= (existing.revision ?? 0)) messages.set(message.id, message);
  }
  const replaced = new Set(page.messages.filter(message => messages.get(message.id) === message).map(message => message.id));
  const deliveries = [...previous.deliveries.filter(delivery => !replaced.has(delivery.messageId)), ...page.deliveries.filter(delivery => replaced.has(delivery.messageId))];
  return {
    ...previous,
    group: page.group.updatedAt >= previous.group.updatedAt ? page.group : previous.group,
    messages: [...messages.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)), deliveries,
    revision: older ? previous.revision : page.revision,
    page: page.page && { total: Math.max(previous.page?.total ?? 0, page.page.total), before: older ? page.page.before : previous.page?.before ?? null },
  };
}

/** A bounded HTTP page on entry, cursored changes afterward, explicit older pages.
 * Both request generation and per-message revisions protect navigation races. */
export function useGroupHistory(id: string | null, revision: string | undefined, reconnect: number, instanceId?: string) {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshRound, setRefreshRound] = useState(0);
  const current = useRef<GroupDetail | null>(null);
  const generation = useRef(0);
  const olderRequest = useRef(false);
  const commit = useCallback((value: GroupDetail) => { current.current = value; setDetail(value); }, []);
  useEffect(() => {
    generation.current++;
    current.current = null; setDetail(null); setError(''); setLoadingOlder(false); olderRequest.current = false;
  }, [id, instanceId]);
  useEffect(() => {
    if (!id || !revision) return;
    const version = generation.current;
    let live = true;
    void (async () => {
      let since = current.current?.group.id === id ? current.current.revision : undefined;
      do {
        const page = await api<GroupDetail>(`/groups/${id}${since ? `?since=${encodeURIComponent(since)}` : ''}`);
        if (!live || version !== generation.current) return;
        const previous = current.current;
        commit(previous && previous.group.id === id && since ? merge(previous, page) : page);
        setError('');
        since = page.nextSince ?? undefined;
      } while (since);
    })().catch(cause => { if (live && version === generation.current) setError(cause.message); });
    return () => { live = false; };
  }, [id, revision, reconnect, refreshRound, instanceId, commit]);
  const loadOlder = useCallback(async () => {
    const previous = current.current;
    if (!id || previous?.group.id !== id || !previous.page?.before || olderRequest.current) return;
    const version = generation.current;
    olderRequest.current = true; setLoadingOlder(true);
    try {
      const page = await api<GroupDetail>(`/groups/${id}?before=${previous.page.before}`);
      if (version !== generation.current || current.current?.group.id !== id) return;
      // An in-flight older page may precede a delta that skipped this unloaded
      // range. Replay changes since the request began after installing the page.
      commit({ ...merge(current.current, page, true), revision: previous.revision });
      setRefreshRound(value => value + 1); setError('');
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : '无法读取历史'); }
    finally { if (version === generation.current) { olderRequest.current = false; setLoadingOlder(false); } }
  }, [id, commit]);
  const readSource = useCallback((messageId: string) => api<GroupMessage>(`/groups/${id}/messages/${encodeURIComponent(messageId)}`), [id]);
  return { detail, error, loadOlder, loadingOlder, readSource };
}
