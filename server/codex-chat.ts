import { randomUUID } from 'node:crypto';
import type { CodexChatAnswer, CodexChatItem, CodexChatRequest, CodexChatSnapshot } from '../shared/chat.ts';

type Obj = Record<string, unknown>;
export const object = (value: unknown): Obj | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : undefined;
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const json = (value: unknown): string => value == null ? '' : JSON.stringify(value, null, 2);
const text = (value: unknown): string => string(value).slice(0, 64_000);
const status = (value: unknown, done: boolean): CodexChatItem['status'] => ['failed', 'declined', 'interrupted'].includes(string(value)) ? 'failed' : done || ['completed', 'success'].includes(string(value)) ? 'completed' : 'inProgress';
const contentText = (value: unknown): string => Array.isArray(value) ? value.flatMap(entry => { const item = object(entry); return item && ['text', 'inputText', 'output_text'].includes(string(item.type)) ? [string(item.text)] : []; }).join('\n') : string(value);
function changesText(value: unknown): string {
  return Array.isArray(value) ? value.slice(0, 200).map(entry => { const change = object(entry); return `${string(change?.path)}\n${string(change?.diff)}`; }).join('\n\n') : '';
}

export function nativeChatItem(value: unknown, turnId?: string, done = false): CodexChatItem | undefined {
  const item = object(value);
  if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 512) return;
  const common = { id: item.id, ...(turnId ? { turnId } : {}), status: status(item.status, done) };
  switch (item.type) {
    case 'userMessage': return { ...common, type: 'user', text: text(contentText(item.content)), status: 'completed' };
    case 'agentMessage': return { ...common, type: 'assistant', text: text(item.text) };
    case 'plan': return { ...common, type: 'plan', text: text(item.text), title: '执行计划' };
    case 'commandExecution': return { ...common, type: 'command', title: '执行命令', text: text(item.command), ...(typeof item.aggregatedOutput === 'string' ? { output: text(item.aggregatedOutput) } : {}) };
    case 'fileChange': return { ...common, type: 'fileChange', title: '文件修改', text: text(Array.isArray(item.changes) ? item.changes.map(value => string(object(value)?.path)).join('\n') : ''), output: text(changesText(item.changes)) };
    case 'mcpToolCall': return { ...common, type: 'tool', title: `${string(item.server)} / ${string(item.tool)}`.slice(0, 200), text: text(json(item.arguments)), output: text(item.error ? json(item.error) : contentText(object(item.result)?.content) || json(object(item.result)?.structuredContent)) };
    case 'dynamicToolCall': return { ...common, type: 'tool', title: string(item.tool).slice(0, 200), text: text(json(item.arguments)), output: text(contentText(item.contentItems)), ...(item.success === false ? { status: 'failed' } : {}) };
    case 'functionCallOutput': return { ...common, type: 'tool', title: string(item.name).slice(0, 200), text: '', output: text(typeof item.output === 'string' ? item.output : json(item.output)) };
    case 'collabAgentToolCall': return { ...common, type: 'tool', title: `子任务 · ${string(item.tool)}`.slice(0, 200), text: text(item.prompt), output: text(json(item.agentsStates)) };
    case 'webSearch': return { ...common, type: 'tool', title: '网页搜索', text: text(item.query || json(item.action)) };
    case 'contextCompaction': return { ...common, type: 'notice', title: '上下文整理', text: 'Codex 正在整理会话上下文。' };
    case 'reasoning': case 'hookPrompt': return; // Internal instructions/reasoning are not conversation output.
    default: return { ...common, type: 'notice', title: '原生事件', text: `Codex：${string(item.type).slice(0, 120) || '未知事件'}` };
  }
}

interface View { snapshot: CodexChatSnapshot; versions: Map<string, number>; turnVersion: number }
export class CodexChatState {
  private views = new Map<string, View>();
  private listeners = new Set<(threadId: string, snapshot: CodexChatSnapshot) => void>();
  onChange(listener: (threadId: string, snapshot: CodexChatSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get(id: string): CodexChatSnapshot | undefined { return this.views.get(id)?.snapshot; }
  turnChanged(id: string, basis: number): boolean { return (this.views.get(id)?.turnVersion ?? 0) > basis; }
  private view(id: string): View {
    let view = this.views.get(id);
    if (!view) {
      view = { snapshot: { nativeSessionId: id, revision: 0, connected: false, activeTurnId: null, items: [], requests: [], truncated: false }, versions: new Map(), turnVersion: 0 };
      this.views.set(id, view);
      if (this.views.size > 128) for (const [key, candidate] of this.views) { if (key !== id && !candidate.snapshot.connected) { this.views.delete(key); break; } }
    }
    return view;
  }
  private publish(id: string, patch: Partial<CodexChatSnapshot>, changed: string[] = []): CodexChatSnapshot {
    const view = this.view(id), old = view.snapshot;
    let items = patch.items ?? old.items, truncated = patch.truncated ?? old.truncated;
    if (items.length > 200) { items = items.slice(-200); truncated = true; }
    let total = 0;
    const bounded: CodexChatItem[] = [];
    for (const item of items.toReversed()) {
      const size = item.text.length + (item.output?.length ?? 0) + (item.title?.length ?? 0);
      if (total + size > 512_000) { truncated = true; break; }
      total += size; bounded.push(item);
    }
    items = bounded.reverse();
    const revision = old.revision + 1;
    view.snapshot = { ...old, ...patch, items, truncated, revision };
    if (patch.activeTurnId !== undefined) view.turnVersion = revision;
    for (const key of changed) view.versions.set(key, revision);
    const visible = new Set(items.map(item => item.id));
    for (const key of view.versions.keys()) if (!visible.has(key)) view.versions.delete(key);
    for (const listener of this.listeners) { try { listener(id, view.snapshot); } catch { /* View consumers cannot break native execution. */ } }
    return view.snapshot;
  }
  connected(id: string, connected: boolean, notice?: string): void {
    this.publish(id, { connected, notice, ...(!connected ? { requests: [] } : {}) });
  }
  requests(id: string, requests: CodexChatRequest[]): void { this.publish(id, { requests }); }
  notice(id: string, notice: string): void { this.publish(id, { notice }); }
  acceptedTurn(id: string, turn: unknown, basis: number): void {
    if (this.view(id).turnVersion <= basis) this.event(id, 'turn/started', { turn });
  }
  private upsert(id: string, item: CodexChatItem): void {
    const items = [...this.view(id).snapshot.items], index = items.findIndex(entry => entry.id === item.id);
    if (index < 0) items.push(item);
    else items[index] = { ...items[index], ...item };
    this.publish(id, { items, ...(item.text.length >= 64_000 || (item.output?.length ?? 0) >= 64_000 ? { truncated: true } : {}) }, [item.id]);
  }
  reconcile(id: string, nativeThread: unknown, basis: number, connected: boolean): CodexChatSnapshot {
    const thread = object(nativeThread);
    if (thread?.id !== id) throw new Error('Codex 返回了不匹配的图形会话');
    const view = this.view(id), turns = Array.isArray(thread.turns) ? thread.turns : [];
    let items: CodexChatItem[] = [], active: string | null = null, truncated = turns.length > 200;
    for (const value of turns.slice(-200)) {
      const turn = object(value);
      if (!turn || typeof turn.id !== 'string') continue;
      if (turn.status === 'inProgress') active = turn.id;
      if (turn.itemsView && turn.itemsView !== 'full') truncated = true;
      if (Array.isArray(turn.items)) for (const entry of turn.items) { const item = nativeChatItem(entry, turn.id, turn.status !== 'inProgress'); if (item) items.push(item); }
      if (items.length > 400) { items = items.slice(-200); truncated = true; }
    }
    const live = view.snapshot.items.filter(item => (view.versions.get(item.id) ?? 0) > basis);
    const newer = new Map(live.map(item => [item.id, item]));
    items = items.map(item => { const current = newer.get(item.id); newer.delete(item.id); return current ?? item; });
    items.push(...newer.values());
    return this.publish(id, { items, connected, truncated: view.snapshot.truncated || truncated || items.some(item => item.text.length >= 64_000 || (item.output?.length ?? 0) >= 64_000), ...(view.turnVersion <= basis ? { activeTurnId: active } : {}), notice: truncated ? '部分原生历史未加载；完整记录可在原生终端查看。' : undefined }, items.map(item => item.id));
  }
  event(id: string, method: string, params: Obj): void {
    const view = this.view(id), turnId = string(params.turnId), itemId = string(params.itemId);
    if (method === 'turn/started') {
      const turn = object(params.turn);
      if (typeof turn?.id === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(turn.id)) this.publish(id, { activeTurnId: turn.id, notice: undefined });
    } else if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (!turn || typeof turn.id !== 'string' || (view.snapshot.activeTurnId && view.snapshot.activeTurnId !== turn.id)) return;
      if (Array.isArray(turn.items)) for (const entry of turn.items) { const item = nativeChatItem(entry, turn.id, true); if (item) this.upsert(id, item); }
      this.publish(id, { activeTurnId: null, items: this.view(id).snapshot.items.map(item => item.turnId === turn.id && item.status === 'inProgress' ? { ...item, status: status(turn.status, true) } : item), notice: string(object(turn.error)?.message) || undefined });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = nativeChatItem(params.item, turnId || undefined, method === 'item/completed');
      if (item) this.upsert(id, item);
    } else if (['item/agentMessage/delta', 'item/plan/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta'].includes(method) && itemId && typeof params.delta === 'string') {
      const previous = view.snapshot.items.find(item => item.id === itemId);
      const isOutput = method.endsWith('outputDelta');
      const type = method.includes('agentMessage') ? 'assistant' : method.includes('commandExecution') ? 'command' : method.includes('fileChange') ? 'fileChange' : 'plan';
      const base: CodexChatItem = previous ?? { id: itemId, turnId, type, text: '', status: 'inProgress' };
      if (base.status !== 'inProgress') return;
      const combined = (isOutput ? base.output ?? '' : base.text) + params.delta;
      this.upsert(id, { ...base, ...(isOutput ? { output: combined.slice(-64_000) } : { text: combined.slice(0, 64_000) }) });
      if (combined.length > 64_000 && !view.snapshot.truncated) this.publish(id, { truncated: true });
    } else if (method === 'item/fileChange/patchUpdated' && itemId) {
      const previous = view.snapshot.items.find(item => item.id === itemId);
      const item = nativeChatItem({ id: itemId, type: 'fileChange', changes: params.changes, status: previous?.status }, turnId);
      if (item) this.upsert(id, item);
    } else if (method === 'item/mcpToolCall/progress' && itemId && typeof params.message === 'string') {
      const previous = view.snapshot.items.find(item => item.id === itemId);
      if (previous?.status !== 'inProgress') return;
      const output = [previous.output, params.message].filter(Boolean).join('\n');
      this.upsert(id, { ...previous, output: output.slice(-64_000) });
    } else if (method === 'turn/plan/updated' && turnId) {
      const plan = Array.isArray(params.plan) ? params.plan.slice(0, 100).map(entry => { const step = object(entry); return `${step?.status === 'completed' ? '✓' : step?.status === 'inProgress' ? '→' : '○'} ${string(step?.step)}`; }).join('\n') : '';
      this.upsert(id, { id: `plan:${turnId}`, turnId, type: 'plan', title: '执行计划', text: text([string(params.explanation), plan].filter(Boolean).join('\n')), status: 'inProgress' });
    } else if (method === 'turn/diff/updated' && turnId) {
      this.upsert(id, { id: `diff:${turnId}`, turnId, type: 'fileChange', title: '本轮修改汇总', text: '', output: text(params.diff), status: 'inProgress' });
    } else if (method === 'error') {
      this.publish(id, { notice: text(object(params.error)?.message) || 'Codex 执行发生错误，请检查原生配置。' });
    }
  }
}

export interface NativeChatRequest {
  view: CodexChatRequest;
  method: string;
  nativeId: number | string;
  turnId?: string;
  decisions: Map<string, unknown>;
}
const decisionLabels: Record<string, string> = { accept: '允许这一次', acceptForSession: '本次会话允许', decline: '拒绝', cancel: '取消本轮' };
export function nativeChatRequest(method: string, nativeId: number | string, params: Obj): NativeChatRequest {
  const id = randomUUID(), decisions = new Map<string, unknown>();
  const view: CodexChatRequest = { id, kind: 'unsupported', title: '需要在原生界面处理', description: `尚未支持的原生请求：${method.slice(0, 160)}` };
  if (json(params).length > 32_000) return { view: { ...view, description: '原生请求过大，图形界面无法完整展示；请在原生界面处理。' }, method, nativeId, decisions };
  const options: { id: string; label: string }[] = [];
  const addDecision = (label: string, result: unknown) => { const id = `decision-${options.length}`; options.push({ id, label }); decisions.set(id, result); };
  if (method === 'item/commandExecution/requestApproval') {
    view.kind = 'approval'; view.title = '命令执行审批'; view.description = text(params.reason);
    view.details = text([string(params.command), params.cwd ? `目录：${string(params.cwd)}` : '', params.additionalPermissions ? `附加权限：\n${json(params.additionalPermissions)}` : '', params.networkApprovalContext ? `网络请求：\n${json(params.networkApprovalContext)}` : '', params.availableDecisions ? `原生审批选项：\n${json(params.availableDecisions)}` : ''].filter(Boolean).join('\n'));
    const available = Array.isArray(params.availableDecisions) ? params.availableDecisions.slice(0, 20) : ['accept', 'acceptForSession', 'decline', 'cancel'];
    for (const decision of available) {
      if (typeof decision === 'string' && decisionLabels[decision]) addDecision(decisionLabels[decision], { decision });
      else if (object(decision)?.acceptWithExecpolicyAmendment) addDecision(`允许并记住命令规则：${json(object(decision)?.acceptWithExecpolicyAmendment).slice(0, 200)}`, { decision });
      else if (object(decision)?.applyNetworkPolicyAmendment) addDecision(`应用网络规则：${json(object(decision)?.applyNetworkPolicyAmendment).slice(0, 200)}`, { decision });
    }
  } else if (method === 'item/fileChange/requestApproval') {
    view.kind = 'approval'; view.title = '文件修改审批'; view.description = text(params.reason); view.details = params.grantRoot ? `申请写入目录：${text(params.grantRoot)}` : '确认是否允许 Codex 应用上方文件修改。';
    for (const decision of ['accept', 'acceptForSession', 'decline', 'cancel']) addDecision(decisionLabels[decision], { decision });
  } else if (method === 'item/permissions/requestApproval') {
    view.kind = 'approval'; view.title = '额外权限审批'; view.description = text(params.reason); view.details = text(`目录：${string(params.cwd)}\n${json(params.permissions)}`);
    const raw = object(params.permissions) ?? {}, permissions = Object.fromEntries(['network', 'fileSystem'].filter(key => raw[key] != null).map(key => [key, raw[key]]));
    addDecision('仅本轮允许', { permissions, scope: 'turn' });
    addDecision('本次会话允许', { permissions, scope: 'session' });
    addDecision('拒绝额外权限', { permissions: {}, scope: 'turn' });
  } else if (method === 'item/tool/requestUserInput' && Array.isArray(params.questions) && params.questions.length > 0 && params.questions.length <= 12) {
    const questions = params.questions.map(value => {
      const q = object(value);
      if (!q || typeof q.id !== 'string' || !q.id || q.id.length > 200 || typeof q.question !== 'string' || (Array.isArray(q.options) && q.options.length > 30)) return;
      return { id: q.id, header: text(q.header), question: text(q.question), isOther: q.isOther === true, isSecret: q.isSecret === true, ...(Array.isArray(q.options) ? { options: q.options.slice(0, 30).map(option => ({ label: text(object(option)?.label), description: text(object(option)?.description) })) } : {}) };
    });
    if (questions.every(question => question !== undefined) && new Set(questions.map(question => question.id)).size === questions.length) { view.kind = 'question'; view.title = 'Codex 需要你的回答'; view.description = params.isBlocking === false ? '此问题不会暂停其他执行。' : '回答后将继续原生任务。'; view.questions = questions; }
  }
  if (options.length) view.options = options;
  else if (view.kind === 'approval') { view.kind = 'unsupported'; view.description = '原生程序未提供可识别的审批选项，请在原生界面处理。'; }
  return { view, method, nativeId, ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}), decisions };
}

export function nativeChatAnswer(request: NativeChatRequest, answer: CodexChatAnswer): unknown {
  if (request.view.kind === 'approval') {
    if (typeof answer.decision !== 'string' || !request.decisions.has(answer.decision) || answer.answers !== undefined) throw new Error('请选择当前原生请求提供的审批选项');
    return request.decisions.get(answer.decision);
  }
  if (request.view.kind === 'question' && answer.decision === undefined && object(answer.answers)) {
    const provided = answer.answers!, questions = request.view.questions ?? [];
    if (Object.keys(provided).some(id => !questions.some(question => question.id === id))) throw new Error('回答包含不属于当前请求的问题');
    const answers: Record<string, { answers: string[] }> = Object.create(null);
    for (const question of questions) {
      const value = provided[question.id];
      if (!Array.isArray(value) || value.length < 1 || value.length > 30 || value.some(text => typeof text !== 'string' || !text.trim() || text.length > 8000)) throw new Error('请完整填写当前问题的回答');
      if (question.options?.length && !question.isOther && value.some(text => !question.options!.some(option => option.label === text))) throw new Error('请从原生问题提供的选项中选择');
      answers[question.id] = { answers: value };
    }
    return { answers };
  }
  throw new Error('此原生请求暂不支持在图形界面答复，请切换原生终端');
}
