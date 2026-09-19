// Per-launch hook: no global backend configuration is modified.
const [url, token, source, ...notification] = process.argv.slice(2);
let input = '';
async function deliver() {
  try {
    const payload = JSON.parse(notification.join(' ') || input || '{}');
    // Lifecycle monitoring only needs identifiers and event names. Prompt,
    // assistant text and tool arguments stay in the native agent's own history.
    const keys = source === 'claude' ? ['session_id', 'hook_event_name', 'notification_type']
      : source === 'codex' ? ['thread-id', 'thread_id', 'type'] : [];
    const event = Object.fromEntries(keys.filter(key => typeof payload?.[key] === 'string').map(key => [key, payload[key]]));
    await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-sessiondeck-token': token },
      body: JSON.stringify({ source, payload: event }), signal: AbortSignal.timeout(2000),
    });
  } catch { /* Monitoring must never block or deny a native agent operation. */ }
}
if (notification.length) void deliver();
else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (input.length < 262144) input += chunk; });
  process.stdin.on('end', deliver);
  setTimeout(() => process.exit(0), 3000).unref();
}
