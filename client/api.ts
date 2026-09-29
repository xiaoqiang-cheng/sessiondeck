let tokenPromise: Promise<string> | undefined;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'ApiError'; }
}

async function request(url: string, options?: RequestInit, timeoutMs = 30_000) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      throw new Error(options?.method && options.method !== 'GET'
        ? '请求超时，操作可能仍在处理中。请先刷新状态、确认结果，再决定是否重试'
        : '请求超时，请检查本地服务后重试');
    }
    throw new Error('无法连接本地服务，请确认 SessionDeck 正在运行');
  }
}

export function getToken(force = false) {
  if (force) tokenPromise = undefined;
  tokenPromise ??= request('/api/config').then(async (response) => {
    if (!response.ok) throw new Error('无法连接 SessionDeck 服务');
    return (await response.json() as { csrfToken: string }).csrfToken;
  }).catch((error) => { tokenPromise = undefined; throw error; });
  return tokenPromise;
}

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const mutation = body !== undefined || (method && method !== 'GET');
  // A cold native start/Fork includes process readiness and several bounded
  // native RPCs. Let the server finish those before offering a retry in the UI.
  const timeoutMs = mutation && /^\/sessions\/[^/]+\/(?:start|fork|stop)$/.test(path) ? 90_000 : 30_000;
  const send = async () => request(`/api${path}`, {
    method: method ?? (mutation ? 'POST' : 'GET'),
    headers: mutation ? { 'Content-Type': 'application/json', 'X-SessionDeck-Token': await getToken() } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, timeoutMs);
  let response = await send();
  if (response.status === 403 && mutation) {
    await getToken(true);
    response = await send();
  }
  const result = await response.json().catch(() => {
    throw new Error(response.ok ? '服务返回了无法读取的数据，请刷新后重试' : `本地服务暂时无法处理请求 (${response.status})`);
  });
  if (!response.ok) throw new ApiError(result.error || `请求失败 (${response.status})`, response.status, result.code);
  return result as T;
}
