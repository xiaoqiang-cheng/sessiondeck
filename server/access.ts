import type { Principal } from './auth.ts';

/**
 * Every API route is classified here; the request guard denies anything that
 * is not listed (tests enumerate the registered routes to keep this complete).
 *
 * - public: reachable before login (login, share redemption, auth status)
 * - owner:  the host owner only (workspace-wide data, Shell, directory browsing,
 *           creating agents, sharing and remote settings)
 * - read:   a share of this session may read it
 * - write:  a writable share of this session may act on it
 * - local:  loopback only, never through the remote listener (native hooks)
 */
export type Access = 'public' | 'owner' | 'read' | 'write' | 'local';
export type Route = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; access: Access };

export const ROUTES: Route[] = [
  { method: 'GET', path: '/api/auth/status', access: 'public' },
  { method: 'POST', path: '/api/auth/login', access: 'public' },
  { method: 'POST', path: '/api/auth/logout', access: 'public' },
  { method: 'POST', path: '/api/auth/redeem', access: 'public' },
  { method: 'POST', path: '/api/auth/password', access: 'local' },
  { method: 'GET', path: '/api/auth/devices', access: 'owner' },
  { method: 'DELETE', path: '/api/auth/devices/:id', access: 'owner' },
  { method: 'GET', path: '/api/remote', access: 'owner' },
  { method: 'POST', path: '/api/remote', access: 'local' },
  { method: 'GET', path: '/api/sessions/:id/shares', access: 'owner' },
  { method: 'POST', path: '/api/sessions/:id/shares', access: 'owner' },
  { method: 'DELETE', path: '/api/shares/:id', access: 'owner' },

  { method: 'GET', path: '/api/config', access: 'read' },
  { method: 'GET', path: '/api/state', access: 'read' },
  { method: 'GET', path: '/api/events', access: 'read' },
  { method: 'GET', path: '/api/sessions/:id/conversation', access: 'read' },
  { method: 'GET', path: '/api/sessions/:id/workspace/tree', access: 'read' },
  { method: 'GET', path: '/api/sessions/:id/workspace/file', access: 'read' },
  { method: 'GET', path: '/api/sessions/:id/workspace/git/status', access: 'read' },
  { method: 'GET', path: '/api/sessions/:id/workspace/git/diff', access: 'read' },
  { method: 'GET', path: '/api/sessions/:id/chat', access: 'read' },
  { method: 'GET', path: '/api/sessions/:id/chat/events', access: 'read' },
  { method: 'GET', path: '/api/sessions/:id/chat/submissions/:requestId', access: 'read' },

  { method: 'POST', path: '/api/sessions/:id/start', access: 'write' },
  { method: 'POST', path: '/api/sessions/:id/stop', access: 'write' },
  { method: 'POST', path: '/api/sessions/:id/read', access: 'write' },
  { method: 'POST', path: '/api/sessions/:id/terminal/image', access: 'write' },
  { method: 'POST', path: '/api/sessions/:id/chat/messages', access: 'write' },
  { method: 'POST', path: '/api/sessions/:id/chat/requests/:requestId', access: 'write' },
  { method: 'POST', path: '/api/sessions/:id/chat/interrupt', access: 'write' },

  { method: 'POST', path: '/api/native-event/:id', access: 'local' },

  { method: 'GET', path: '/api/shells', access: 'owner' },
  { method: 'POST', path: '/api/shells', access: 'owner' },
  { method: 'DELETE', path: '/api/shells/:id', access: 'owner' },
  { method: 'POST', path: '/api/directories/list', access: 'owner' },
  { method: 'POST', path: '/api/backends/refresh', access: 'owner' },
  { method: 'GET', path: '/api/discover', access: 'owner' },
  { method: 'POST', path: '/api/import', access: 'owner' },
  { method: 'POST', path: '/api/sessions', access: 'owner' },
  { method: 'PATCH', path: '/api/sessions/:id', access: 'owner' },
  { method: 'POST', path: '/api/sessions/:id/fork', access: 'owner' },
  { method: 'POST', path: '/api/groups', access: 'owner' },
  { method: 'PATCH', path: '/api/groups/:id', access: 'owner' },
  { method: 'GET', path: '/api/groups/:id', access: 'owner' },
  { method: 'GET', path: '/api/groups/:id/messages/:messageId', access: 'owner' },
  { method: 'POST', path: '/api/groups/:id/messages', access: 'owner' },
  { method: 'POST', path: '/api/deliveries/:id/send', access: 'owner' },
  { method: 'POST', path: '/api/deliveries/:id/resolve', access: 'owner' },
  { method: 'POST', path: '/api/deliveries/:id/cancel', access: 'owner' },
];

const compiled = ROUTES.map(route => ({
  ...route,
  pattern: new RegExp(`^${route.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:([a-zA-Z]+)/g, '/(?<$1>[^/]+)')}$`),
}));

export function matchRoute(method: string, path: string) {
  const verb = method === 'HEAD' ? 'GET' : method;
  for (const route of compiled) {
    if (route.method !== verb) continue;
    const match = route.pattern.exec(path);
    if (match) return { route, params: match.groups ?? {} };
  }
  return null;
}

export type Decision = { allowed: true } | { allowed: false; status: 401 | 403 | 404; error: string };

/**
 * Decides one API request. Shares are scoped to exactly one session: every
 * `:id` must be theirs, and workspace-wide reads are filtered by the caller.
 */
export function authorize(principal: Principal | null, remote: boolean, method: string, path: string): Decision {
  const matched = matchRoute(method, path);
  if (!matched) return { allowed: false, status: 404, error: '接口不存在' };
  const { route, params } = matched;
  if (route.access === 'public') return { allowed: true };
  if (route.access === 'local') return remote ? { allowed: false, status: 403, error: '此操作只能在运行 SessionDeck 的电脑上进行' } : { allowed: true };
  if (!principal) return { allowed: false, status: 401, error: '请先登录' };
  if (principal.kind === 'owner') return { allowed: true };
  if (route.access === 'owner') return { allowed: false, status: 403, error: '分享链接无权执行此操作' };
  if (route.access === 'write' && principal.mode !== 'write') return { allowed: false, status: 403, error: '这是只读分享' };
  // Session-bound routes must target the shared session; the rest are filtered.
  if (params.id !== undefined && params.id !== principal.sessionId) return { allowed: false, status: 404, error: '会话不存在' };
  return { allowed: true };
}
