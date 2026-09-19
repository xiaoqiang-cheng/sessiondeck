export type Backend = 'claude' | 'codex' | 'dsh';
export type SessionStatus = 'idle' | 'running' | 'waiting_input' | 'waiting_approval' | 'error' | 'stopped' | 'unknown';
export type StatusSource = 'native' | 'terminal' | 'manual' | 'process';

export interface BackendInfo {
  id: Backend;
  label: string;
  installed: boolean;
  version: string | null;
  capabilities: { terminal: boolean; resume: boolean; fork: boolean; discovery: boolean; nativeControl?: boolean };
  note?: string;
}

export interface Session {
  id: string;
  backend: Backend;
  title: string;
  cwd: string;
  nativeSessionId: string | null;
  nativeUrl?: string | null;
  groupId: string | null;
  parentId: string | null;
  forkPending: boolean;
  status: SessionStatus;
  statusSource: StatusSource;
  statusDetail: string;
  lastActivity: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  pinned: boolean;
  unread: number;
  /** Stable native attention identity prevents replayed events from reminding twice. */
  lastAttentionKey?: string | null;
  running: boolean;
  origin: 'created' | 'imported' | 'forked';
}

export interface DiscoveredSession {
  backend: Backend;
  nativeSessionId: string;
  title: string;
  cwd: string;
  lastActivity: string;
}

export interface Group {
  id: string;
  title: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  senderId: string | null;
  senderName: string;
  kind: 'note' | 'task' | 'result';
  text: string;
  recipientIds: string[];
  /** Existing message this handoff continues; always from the same group. */
  sourceMessageId?: string | null;
  createdAt: string;
}

export interface Delivery {
  id: string;
  messageId: string;
  sessionId: string;
  text: string;
  status: 'pending' | 'staged' | 'sent' | 'cancelled';
  createdAt: string;
  sentAt: string | null;
}

export interface Activity {
  id: string;
  sessionId: string | null;
  type: string;
  text: string;
  createdAt: string;
}

export interface AppState {
  /** Order snapshots across HTTP and SSE; a new process has a new instance ID. */
  instanceId?: string;
  revision?: number;
  sessions: Session[];
  groups: Group[];
  backends: BackendInfo[];
  activities: Activity[];
  defaultCwd: string;
  demo: boolean;
}

export interface GroupDetail {
  group: Group;
  messages: GroupMessage[];
  deliveries: Delivery[];
}
