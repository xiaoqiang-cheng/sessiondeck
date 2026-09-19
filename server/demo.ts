import type { BackendInfo } from '../shared/types.ts';
import type { Store } from './store.ts';

export const demoBackends: BackendInfo[] = [
  { id: 'claude', label: 'Claude Code', installed: true, version: '演示', capabilities: { terminal: true, resume: true, fork: true, discovery: true } },
  { id: 'codex', label: 'Codex', installed: true, version: '演示', capabilities: { terminal: true, resume: true, fork: true, discovery: true } },
  { id: 'dsh', label: 'DeepSeek Harness', installed: true, version: '演示', capabilities: { terminal: true, resume: true, fork: true, discovery: true } },
];

export function seedDemo(store: Store, cwd: string) {
  if (store.sessions().length || store.groups().length) return;
  const group = store.addGroup('登录体验优化', '梳理登录流程、实现交互，并验证异常场景。');
  const a = store.addSession({ backend: 'claude', title: '梳理登录流程', cwd, nativeSessionId: 'demo-claude', groupId: group.id, status: 'waiting_input', statusSource: 'manual', statusDetail: '演示：等待确认登录方式', unread: 1, pinned: true });
  store.addSession({ backend: 'codex', title: '实现登录表单', cwd, nativeSessionId: 'demo-codex', groupId: group.id, status: 'idle', statusDetail: '演示：准备继续实现' });
  store.addSession({ backend: 'dsh', title: '验证边界场景', cwd, nativeSessionId: 'demo-dsh', groupId: group.id, status: 'idle', statusDetail: '演示：等待测试任务' });
  store.addSession({ backend: 'codex', title: 'SessionDeck · 开发笔记', cwd, nativeSessionId: 'demo-personal', pinned: true });
  store.addMessage({ groupId: group.id, senderId: null, senderName: '你', kind: 'note', text: '先确定登录流程，再推进实现。每个成员都可以单独进入会话调整方向。', recipientIds: [] });
  store.addMessage({ groupId: group.id, senderId: a.id, senderName: a.title, kind: 'result', text: '建议第一版保留邮箱登录，并把错误提示放在输入项下方。等待确认后继续。', recipientIds: [] });
}

export function demoCommand() {
  const script = `process.stdout.write('\\x1b[36mSessionDeck · 本地演示终端\\x1b[0m\\r\\n这里不会调用模型，也不会执行输入的命令。\\r\\n\\r\\n> '); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { if (d.includes('\\x03')) { process.exit(0); } process.stdout.write('\\r\\n已收到演示输入：' + d.replace(/\\x1b\\[(200|201)~/g, '').trim() + '\\r\\n> '); });`;
  return { file: process.execPath, args: ['-e', script] };
}
