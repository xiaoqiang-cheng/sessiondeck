import { useEffect, useRef, useState, type ClipboardEvent, type ChangeEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ArrowDownToLine, Copy, Check, ImagePlus, Keyboard, LoaderCircle, Maximize2, Minimize2, Send, WifiOff, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { getToken, uploadTerminalImage } from './api';
import { MAX_TERMINAL_IMAGE_BYTES, TERMINAL_IMAGE_TYPES } from '../shared/terminal-images';

const touchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/**
 * Touch scrolling. xterm stacks its screen above the scrollable viewport, so a
 * finger drag on the terminal moves nothing by itself. Drags are turned into
 * whole rows and routed the way xterm routes a wheel: a mouse-tracking app
 * (Claude Code) gets wheel reports and an alternate screen without tracking
 * gets arrow keys, both through a synthetic wheel event that xterm's own
 * handlers read; a normal buffer scrolls through the public scrollLines API,
 * because xterm 6's scroller only trusts the legacy wheelDelta fields that a
 * synthetic event leaves at zero. A short momentum phase follows the finger.
 */
function attachTouchScroll(container: HTMLElement, terminal: Terminal) {
  let tracking = false, lastX = 0, lastY = 0, lastTime = 0, velocity = 0, pending = 0, frame = 0;
  const rowHeight = () => {
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    return screen && terminal.rows && screen.clientHeight ? screen.clientHeight / terminal.rows : 18;
  };
  // dy is finger travel in px; content follows the finger, so finger down
  // means wheel up (negative deltaY). Whole rows keep every mode consistent.
  const emit = (dy: number) => {
    pending -= dy;
    const height = rowHeight();
    const rows = Math.trunc(pending / height);
    if (!rows) return;
    pending -= rows * height;
    const trackingApp = terminal.modes.mouseTrackingMode !== 'none';
    if (!trackingApp && terminal.buffer.active.type === 'normal') { terminal.scrollLines(rows); return; }
    // Coordinates matter: the tracking report is dropped when the event falls
    // outside the screen.
    const target = terminal.element?.querySelector('.xterm-screen') ?? terminal.element;
    target?.dispatchEvent(new WheelEvent('wheel', { deltaY: rows, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true, clientX: lastX, clientY: lastY }));
  };
  const stopMomentum = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) { tracking = false; return; }
    stopMomentum(); tracking = true; velocity = 0; pending = 0;
    lastX = event.touches[0].clientX; lastY = event.touches[0].clientY; lastTime = event.timeStamp;
  };
  const move = (event: TouchEvent) => {
    if (!tracking || event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    const dy = y - lastY, dt = Math.max(1, event.timeStamp - lastTime);
    velocity = 0.7 * (dy / dt) + 0.3 * velocity;
    lastX = event.touches[0].clientX; lastY = y; lastTime = event.timeStamp;
    event.preventDefault();
    emit(dy);
  };
  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (Math.abs(velocity) < 0.25) return;
    let previous = performance.now(), v = velocity;
    const step = (now: number) => {
      const dt = Math.min(64, now - previous); previous = now;
      emit(v * dt);
      v *= Math.pow(0.93, dt / 16);
      frame = Math.abs(v) > 0.03 ? requestAnimationFrame(step) : 0;
    };
    frame = requestAnimationFrame(step);
  };
  const cancel = () => { tracking = false; };
  container.addEventListener('touchstart', start, { passive: true });
  container.addEventListener('touchmove', move, { passive: false });
  container.addEventListener('touchend', end);
  container.addEventListener('touchcancel', cancel);
  return () => {
    stopMomentum();
    container.removeEventListener('touchstart', start); container.removeEventListener('touchmove', move);
    container.removeEventListener('touchend', end); container.removeEventListener('touchcancel', cancel);
  };
}

export default function TerminalPane({ sessionId, running, status, allowImages: imagesRequested, onSelection, channel = 'session', onExit, focusRequest, readOnly: readOnlyRequested = false }: {
  sessionId: string; running: boolean; status?: string; allowImages?: boolean; onSelection: (text: string) => void;
  channel?: 'session' | 'shell'; onExit?: (exitCode: number) => void; focusRequest?: number;
  /** Watch only. The server also discards input from read-only shares. */
  readOnly?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const selectionRef = useRef(onSelection);
  const exitRef = useRef(onExit);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // A plain textarea, like the Codex chat composer: every keyboard can type
  // Chinese into it. Default on touch devices; a toolbar toggle elsewhere.
  const [composerOpen, setComposerOpen] = useState(touchDevice);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const acceptsInputRef = useRef(false);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [imageStatus, setImageStatus] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [serverReadOnly, setServerReadOnly] = useState(false);
  const readOnly = readOnlyRequested || serverReadOnly;
  const allowImages = imagesRequested && !readOnly;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const terminalIdRef = useRef<string | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadingRef = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previousFullscreenRef = useRef(fullscreen);
  selectionRef.current = onSelection;
  exitRef.current = onExit;

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    socketRef.current = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let everConnected = false;
    let attempts = 0;
    let acceptsInput = running && !readOnlyRequested;
    acceptsInputRef.current = acceptsInput;
    setConnected(false); setError(''); setCopied(false);
    terminalIdRef.current = null; setTerminalId(null); setImageStatus('');
    uploadAbortRef.current?.abort(); uploadAbortRef.current = null; uploadingRef.current = false; setUploadingImage(false);
    selectionRef.current('');
    const terminal = new Terminal({
      cursorBlink: true, fontSize: 13, lineHeight: 1.25, scrollback: 8000,
      disableStdin: true, screenReaderMode: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      theme: {
        background: '#16181d', foreground: '#e6e7ea', cursor: '#e6e7ea',
        selectionBackground: '#3b4250', black: '#16181d', red: '#f28b82', green: '#9fd89f',
        yellow: '#f2d479', blue: '#8ab4f8', magenta: '#c58af9', cyan: '#78d9ec', white: '#e6e7ea',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    // Esc belongs to the native CLI, so fullscreen uses a chord xterm never forwards.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey && (event.metaKey || event.ctrlKey)) { setFullscreen((value) => !value); return false; }
      // While an IME candidate list is open, digits and Space pick a candidate.
      // Leave those keys to the IME; the chosen text arrives through the
      // composition end event, never as a raw keystroke. Only an active
      // composition qualifies: keyCode 229 outside one is how xterm learns
      // that an IME committed text straight into its textarea (fcitx/ibus on
      // Linux), and blocking it silenced Chinese input entirely.
      if (event.isComposing) return false;
      return true;
    });
    terminal.textarea?.setAttribute('aria-label', channel === 'shell' ? 'Shell 终端输入' : '原生会话终端输入');
    // Mobile keyboards (iOS Pinyin, WeChat, Sogou) commit text in ways xterm's
    // keydown-driven path cannot follow, and any second listener on its
    // textarea sends everything twice. On touch devices text goes through the
    // composer below instead; the hidden textarea keeps focus for the caret
    // and hardware keys but never raises the on-screen keyboard.
    if (touchDevice) terminal.textarea?.setAttribute('inputmode', 'none');
    const detachTouchScroll = touchDevice ? attachTouchScroll(containerRef.current, terminal) : null;
    terminalRef.current = terminal;
    fitRef.current = fit;
    function resize() {
      if (disposed || !containerRef.current?.offsetWidth) return;
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(containerRef.current);
    const input = terminal.onData((data) => {
      if (!acceptsInput || uploadingRef.current || socket?.readyState !== WebSocket.OPEN) return;
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 4096, data.length);
        if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end--;
        socket.send(JSON.stringify({ type: 'input', data: data.slice(offset, end) }));
        offset = end;
      }
    });
    const selection = terminal.onSelectionChange(() => selectionRef.current(terminal.getSelection()));
    const scheduleReconnect = () => {
      if (disposed) return;
      clearTimeout(reconnect);
      const delay = Math.min(1500 * 2 ** attempts++, 15_000);
      reconnect = setTimeout(connect, delay);
    };
    async function connect() {
      try {
        const token = await getToken(true);
        if (disposed) return;
        const path = channel === 'shell' ? `/api/shells/${encodeURIComponent(sessionId)}/terminal` : `/api/terminal/${encodeURIComponent(sessionId)}`;
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}?token=${encodeURIComponent(token)}`);
        socketRef.current = socket;
        socket.onopen = () => {
          if (disposed) { socket?.close(); return; }
          if (everConnected) terminal.reset();
          everConnected = true;
          attempts = 0;
          terminal.options.disableStdin = !acceptsInput;
          setConnected(true); setError(''); resize();
        };
        socket.onmessage = (event) => {
          if (disposed) return;
          try {
            const message = JSON.parse(event.data as string);
            if (message.type === 'data') terminal.write(message.data);
            if (message.type === 'ready') {
              terminalIdRef.current = typeof message.terminalId === 'string' ? message.terminalId : null;
              setTerminalId(terminalIdRef.current);
              if (message.readOnly === true) { acceptsInput = false; terminal.options.disableStdin = true; }
              acceptsInputRef.current = acceptsInput;
              setServerReadOnly(message.readOnly === true);
              if (channel === 'shell' && typeof message.running === 'boolean') {
                acceptsInput = message.running;
                acceptsInputRef.current = acceptsInput;
                terminal.options.disableStdin = !acceptsInput;
                if (!acceptsInput) exitRef.current?.(message.exitCode ?? 0);
              }
            }
            if (message.type === 'error') setError(message.message || message.error || '终端连接遇到问题');
            if (message.type === 'exit') {
              acceptsInput = false; acceptsInputRef.current = false; terminal.options.disableStdin = true;
              terminal.write(`\r\n\x1b[90m[进程已退出 · ${message.exitCode ?? 0}]\x1b[0m\r\n`);
              exitRef.current?.(message.exitCode ?? 0);
            }
          } catch { setError('无法读取终端消息'); }
        };
        socket.onclose = (event) => {
          if (disposed) return;
          terminal.options.disableStdin = true;
          terminalIdRef.current = null; setTerminalId(null);
          if (uploadingRef.current) setImageStatus('终端连接中断，图片可能已经填入；请先检查输入中的 [Image #1] 再决定是否重试');
          setConnected(false);
          if (channel === 'shell' && event.code === 1000) { setError('Shell 已关闭'); return; }
          if (everConnected) setError('终端连接已中断，正在自动重连；连接恢复后可继续输入');
          scheduleReconnect();
        };
        socket.onerror = () => { if (!disposed) setError('终端连接暂时中断，正在重连'); };
      } catch (cause) {
        if (!disposed) { setError(cause instanceof Error ? cause.message : '终端连接失败'); scheduleReconnect(); }
      }
    }
    void connect();
    return () => {
      disposed = true; clearTimeout(reconnect); clearTimeout(copiedTimer.current); uploadAbortRef.current?.abort(); uploadAbortRef.current = null; uploadingRef.current = false; socket?.close(); input.dispose(); selection.dispose();
      detachTouchScroll?.(); resizeObserver.disconnect(); terminal.dispose(); terminalRef.current = null; fitRef.current = null;
    };
  }, [sessionId, running, channel, readOnlyRequested]);
  useEffect(() => {
    // Focus follows an explicit activation, never a socket reconnect. Only the
    // requested split pane receives focus when several terminals mount together.
    if (channel === 'shell' && focusRequest === undefined) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [sessionId, channel, focusRequest]);
  useEffect(() => {
    if (previousFullscreenRef.current === fullscreen) return;
    previousFullscreenRef.current = fullscreen;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [fullscreen]);

  async function stageImage(file: File) {
    if (!allowImages) return;
    if (uploadingRef.current) {
      setImageStatus('图片仍在上传，请等待当前图片填入后再添加下一张');
      return;
    }
    if (status === 'waiting_approval') { setImageStatus('原生会话正在等待审批，请先完成审批后再添加图片'); return; }
    if (!(TERMINAL_IMAGE_TYPES as readonly string[]).includes(file.type)) { setImageStatus('仅支持 PNG、JPEG、GIF 或 WebP 图片'); return; }
    if (file.size > MAX_TERMINAL_IMAGE_BYTES) { setImageStatus('图片不能超过 10 MiB'); return; }
    const generation = terminalIdRef.current;
    if (!running || !connected || !generation) { setImageStatus('终端尚未连接完成，请稍后再添加图片'); return; }
    const controller = new AbortController();
    uploadAbortRef.current = controller; uploadingRef.current = true; setUploadingImage(true); setImageStatus('正在把图片填入原生输入…');
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    try {
      await uploadTerminalImage(sessionId, generation, file, controller.signal);
      if (uploadAbortRef.current !== controller) return;
      if (terminalIdRef.current !== generation || !connected) {
        setImageStatus('终端已切换，图片结果可能未知；请检查原生输入后再重试');
      } else {
        setImageStatus('图片已填入原生输入，请确认出现 [Image #1] 后按回车发送');
      }
    } catch (cause) {
      if (uploadAbortRef.current !== controller) return;
      setImageStatus(cause instanceof Error ? cause.message : '图片上传失败，结果可能未知，请先检查原生输入');
    } finally {
      if (uploadAbortRef.current !== controller) return;
      uploadAbortRef.current = null;
      uploadingRef.current = false; setUploadingImage(false);
      // `connected` belongs to the render that started the upload and may be
      // stale after a socket close. The terminal generation is the authoritative
      // connection identity, so only re-enable input for that same PTY.
      if (terminalRef.current && running && terminalIdRef.current === generation) terminalRef.current.options.disableStdin = false;
    }
  }
  function onPasteCapture(event: ClipboardEvent<HTMLDivElement>) {
    if (!allowImages) return;
    const image = Array.from(event.clipboardData.items).map(item => item.kind === 'file' ? item.getAsFile() : null).find((item): item is File => !!item && item.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault(); event.stopPropagation(); void stageImage(image);
  }
  function onImageSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void stageImage(file);
  }

  const sendRaw = (data: string) => {
    const socket = socketRef.current;
    if (!acceptsInputRef.current || uploadingRef.current || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'input', data }));
    return true;
  };
  const sendDraft = () => {
    const text = draft;
    if (!text.trim() || !terminalRef.current) return;
    // paste() honours bracketed paste, so multi-line text lands as one block
    // instead of the first line submitting early; Enter follows separately.
    terminalRef.current.paste(text.replace(/\r?\n$/, ''));
    setDraft('');
    window.setTimeout(() => sendRaw('\r'), 40);
    composerRef.current?.focus();
  };
  const quickKeys: [string, string, string][] = [['Esc', '\x1b', '发送 Esc'], ['Tab', '\t', '发送 Tab'], ['↑', '\x1b[A', '上一条'], ['↓', '\x1b[B', '下一条'], ['^C', '\x03', '发送 Ctrl+C'], ['⏎', '\r', '发送回车']];
  const toggleLabel = fullscreen ? '退出全屏' : '全屏';
  return <div className={`terminal-pane ${fullscreen ? 'fullscreen' : ''}`} onPasteCapture={onPasteCapture}>
    <div className="terminal-toolbar">{readOnly && <span className="terminal-readonly">只读查看</span>}<span title={connected ? '浏览器已连接终端通道；任务是否执行请查看会话状态' : '正在连接终端通道'} className={`terminal-connection ${connected ? 'connected' : ''}`}><i />{connected ? '已连接' : '连接中'}</span><div>
      {allowImages && <><input ref={fileInputRef} className="terminal-image-input" type="file" accept={TERMINAL_IMAGE_TYPES.join(',')} onChange={onImageSelected} /><button title="选择图片并填入原生输入" aria-label="选择图片并填入原生输入" disabled={!connected || !terminalId || !running || uploadingImage} onClick={() => fileInputRef.current?.click()}>{uploadingImage ? <LoaderCircle className="spin" size={14} /> : <ImagePlus size={14} />}</button></>}
      <button title="复制选中的终端内容" aria-label="复制选中的终端内容" onClick={async () => {
        const selected = terminalRef.current?.getSelection();
        if (!selected) { setError('先在终端中选中要复制的内容'); return; }
        try { await navigator.clipboard.writeText(selected); setCopied(true); setError(''); clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(false), 1800); }
        catch { setError('浏览器无法访问剪贴板，请使用系统复制快捷键'); }
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
      {channel === 'session' && <button title={composerOpen ? '隐藏输入栏' : '显示输入栏（适合手机和中文输入）'} aria-label={composerOpen ? '隐藏输入栏' : '显示输入栏'} aria-pressed={composerOpen} onClick={() => setComposerOpen(value => !value)}><Keyboard size={14} /></button>}
      <button title="回到终端底部" aria-label="回到终端底部" onClick={() => { terminalRef.current?.scrollToBottom(); terminalRef.current?.focus(); }}><ArrowDownToLine size={14} /></button>
      <button title={`${toggleLabel}（Ctrl / ⌘ + Shift + Enter）`} aria-label={toggleLabel} aria-pressed={fullscreen} onClick={() => setFullscreen((value) => !value)}>{fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
    </div></div>
    {imageStatus && <div className="terminal-image-status" role="status" aria-live="polite"><ImagePlus size={14} /><span>{imageStatus}</span>{uploadingImage && <LoaderCircle className="spin" size={13} />}</div>}
    {error && <div className="terminal-error" role="alert"><WifiOff size={14} /><span>{error}</span><button className="terminal-dismiss" aria-label="关闭终端提示" onClick={() => setError('')}><X size={13} /></button></div>}
    <div ref={containerRef} className="terminal-container" />
    {composerOpen && channel === 'session' && !readOnly && <div className="terminal-composer">
      <div className="terminal-quick-keys" role="group" aria-label="快捷按键">{quickKeys.map(([label, data, title]) => <button key={label} type="button" title={title} aria-label={title} disabled={!connected || !running} onClick={() => { sendRaw(data); composerRef.current?.focus(); }}>{label}</button>)}</div>
      <div className="terminal-composer-row">
        <textarea ref={composerRef} aria-label="终端输入栏" placeholder={running ? '输入内容，回车发送；Shift+回车换行' : '启动会话后可以输入'} rows={1} value={draft} disabled={!connected || !running} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendDraft(); } }} />
        <button type="button" className="terminal-send" aria-label="发送到终端" title="发送到终端（回车）" disabled={!connected || !running || !draft.trim()} onClick={sendDraft}><Send size={15} /></button>
      </div>
    </div>}
    {!running && <div className="terminal-hint">{channel === 'shell' ? 'Shell 已退出，可以关闭此终端或新建一个。' : '启动会话后，在这里使用原生 CLI。'}</div>}
  </div>;
}
