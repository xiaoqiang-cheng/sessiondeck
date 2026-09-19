import { validateNativeId } from './adapters.ts';
import type { Session } from '../shared/types.ts';

/** A hook is useful only when both its native identity and lifecycle event are
 * recognizable. Never derive a state from conversation text or unknown hooks. */
export function nativeHookPatch(session: Session, payload: unknown, expectedId?: string): Partial<Session> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || session.backend === 'dsh') return null;
  const row = payload as Record<string, unknown>;
  const nativeId = session.backend === 'claude' ? row.session_id : row['thread-id'] ?? row.thread_id;
  if (typeof nativeId !== 'string') return null;
  try { validateNativeId(session.backend, nativeId); } catch { return null; }
  if (expectedId && expectedId !== nativeId) return null;
  if (session.nativeSessionId && !session.forkPending && session.nativeSessionId !== nativeId) return null;
  if (session.forkPending && session.nativeSessionId === nativeId) return null;

  const patch: Partial<Session> = { nativeSessionId: nativeId, forkPending: false, statusSource: 'native' };
  const event = session.backend === 'claude' ? row.hook_event_name : row.type;
  if (session.backend === 'codex') {
    if (event !== 'agent-turn-complete') return null;
    Object.assign(patch, { status: 'waiting_input', statusDetail: '本轮回复已结束，可以继续或验收' });
  } else if (event === 'UserPromptSubmit') Object.assign(patch, { status: 'running', statusDetail: '原生事件：正在处理你的输入' });
  else if (event === 'PostToolUse' || event === 'PostToolUseFailure') Object.assign(patch, { status: 'running', statusDetail: '原生工具已返回，Agent 正在继续处理' });
  else if (event === 'Stop') Object.assign(patch, { status: 'waiting_input', statusDetail: '本轮回复已结束，可以继续或验收' });
  else if (event === 'SessionStart') Object.assign(patch, { status: 'idle', statusDetail: '原生会话已就绪' });
  else if (event === 'PermissionRequest' || (event === 'Notification' && row.notification_type === 'permission_prompt')) Object.assign(patch, { status: 'waiting_approval', statusDetail: '原生会话正在等待你的审批' });
  else if (event === 'Notification' && row.notification_type === 'idle_prompt') Object.assign(patch, { status: 'waiting_input', statusDetail: '原生会话正在等待你的输入' });
  else return null;
  return patch;
}
