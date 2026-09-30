export type ShareMode = 'read' | 'write';

export interface AuthDevice {
  id: string;
  kind: 'owner' | 'share';
  shareId?: string;
  name: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
}

export interface Share {
  id: string;
  sessionId: string;
  mode: ShareMode;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  devices: AuthDevice[];
}

/** What the browser is allowed to be. `owner` on loopback never needs a password. */
export type AuthStatus =
  | { kind: 'anonymous'; remote: true; passwordSet: boolean }
  | { kind: 'owner'; remote: boolean; passwordSet: boolean }
  | { kind: 'share'; remote: boolean; sessionId: string; mode: ShareMode; name: string };

export interface RemoteSettings {
  enabled: boolean;
  /** Public origin, for example https://deck.example.com */
  publicUrl: string;
  /** Loopback port on this machine that the tunnel exposes. Always requires login. */
  localPort: number;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  identityFile: string;
  /** Loopback port on the server that Caddy proxies to. */
  serverPort: number;
}

export type TunnelState = 'off' | 'connecting' | 'connected' | 'error';
export interface RemoteStatus {
  settings: RemoteSettings;
  tunnel: { state: TunnelState; since: string | null; error: string; attempts: number };
  listening: boolean;
  caddy: string;
}
