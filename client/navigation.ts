import { useCallback, useEffect, useRef, useState } from 'react';

export type View = 'contacts' | 'attention' | 'running' | 'archive' | 'backends' | 'activity' | `group:${string}`;
export interface WorkspaceRoute { view: View; selectedId: string | null }

const plainViews = new Set(['contacts', 'attention', 'running', 'archive', 'backends', 'activity']);
const validId = (value: string | null): value is string => !!value && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function readWorkspaceRoute(hash: string): WorkspaceRoute {
  try {
    const [rawPath, search = ''] = hash.replace(/^#/, '').split('?');
    const parts = rawPath.split('/').filter(Boolean).map(decodeURIComponent);
    let view: View = 'contacts';
    if (parts.length === 1 && plainViews.has(parts[0])) view = parts[0] as View;
    else if (parts.length === 2 && parts[0] === 'groups' && validId(parts[1])) view = `group:${parts[1]}`;
    const selectedId = new URLSearchParams(search).get('session');
    return { view, selectedId: validId(selectedId) ? selectedId : null };
  } catch { return { view: 'contacts', selectedId: null }; }
}

export function workspaceHash(route: WorkspaceRoute) {
  const path = route.view.startsWith('group:') ? `/groups/${encodeURIComponent(route.view.slice(6))}` : `/${route.view}`;
  return `#${path}${route.selectedId ? `?session=${encodeURIComponent(route.selectedId)}` : ''}`;
}

/** Hash routes keep local deployment path independent and never start an Agent. */
export function useWorkspaceRoute() {
  const [route, setRoute] = useState(() => readWorkspaceRoute(location.hash));
  const routeRef = useRef(route);
  const updateRoute = useCallback((patch: Partial<WorkspaceRoute>, replace = false) => {
    const next = { ...routeRef.current, ...patch };
    const hash = workspaceHash(next);
    if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](history.state, '', hash);
    if (routeRef.current.view !== next.view || routeRef.current.selectedId !== next.selectedId) {
      routeRef.current = next; setRoute(next);
    }
  }, []);
  useEffect(() => {
    const readLocation = () => {
      const next = readWorkspaceRoute(location.hash);
      const normalized = workspaceHash(next);
      if (location.hash !== normalized) history.replaceState(history.state, '', normalized);
      if (routeRef.current.view !== next.view || routeRef.current.selectedId !== next.selectedId) {
        routeRef.current = next; setRoute(next);
      }
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    window.addEventListener('hashchange', readLocation);
    return () => { window.removeEventListener('popstate', readLocation); window.removeEventListener('hashchange', readLocation); };
  }, []);
  return { ...route, updateRoute };
}
