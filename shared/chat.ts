/** SessionDeck's bounded view of native Codex items; the native thread owns execution. */
export interface CodexChatItem {
  id: string;
  turnId?: string;
  type: 'user' | 'assistant' | 'command' | 'fileChange' | 'tool' | 'plan' | 'notice';
  text: string;
  title?: string;
  output?: string;
  status: 'inProgress' | 'completed' | 'failed';
}

export interface CodexChatRequest {
  /** Opaque handle bound to the native connection and original request. */
  id: string;
  kind: 'approval' | 'question' | 'unsupported';
  title: string;
  description?: string;
  details?: string;
  options?: { id: string; label: string }[];
  questions?: { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] }[];
}

export interface CodexChatSnapshot {
  instanceId?: string;
  nativeSessionId: string | null;
  revision: number;
  connected: boolean;
  activeTurnId: string | null;
  items: CodexChatItem[];
  requests: CodexChatRequest[];
  truncated: boolean;
  notice?: string;
}

export interface CodexChatPatch extends Omit<CodexChatSnapshot, 'items'> {
  baseRevision: number;
  /** Only changed items. Order also removes items evicted from the bounded view. */
  items: CodexChatItem[];
  order: string[];
}

export interface CodexChatAnswer {
  decision?: string;
  answers?: Record<string, string[]>;
}

export interface CodexChatSubmission {
  requestId: string;
  status: 'sending' | 'accepted' | 'unknown' | 'rejected';
  turnId?: string;
  error?: string;
}
