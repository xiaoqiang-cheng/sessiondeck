import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ArrowDownToLine, Copy, Check, Maximize2, Minimize2, WifiOff, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { getToken } from './api';

export default function TerminalPane({ sessionId, running, onSelection }: {
  sessionId: string; running: boolean; onSelection: (text: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const selectionRef = useRef(onSelection);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  selectionRef.current = onSelection;

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let everConnected = false;
    let attempts = 0;
    setConnected(false); setError(''); setCopied(false);
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
      return true;
    });
    terminal.textarea?.setAttribute('aria-label', '原生会话终端输入');
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
      if (!running || socket?.readyState !== WebSocket.OPEN) return;
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
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`);
        socket.onopen = () => {
          if (disposed) { socket?.close(); return; }
          if (everConnected) terminal.reset();
          everConnected = true;
          attempts = 0;
          terminal.options.disableStdin = !running;
          setConnected(true); setError(''); resize(); terminal.focus();
        };
        socket.onmessage = (event) => {
          if (disposed) return;
          try {
            const message = JSON.parse(event.data as string);
            if (message.type === 'data') terminal.write(message.data);
            if (message.type === 'error') setError(message.message || message.error || '终端连接遇到问题');
            if (message.type === 'exit') terminal.write(`\r\n\x1b[90m[进程已退出 · ${message.exitCode ?? 0}]\x1b[0m\r\n`);
          } catch { setError('无法读取终端消息'); }
        };
        socket.onclose = () => {
          if (disposed) return;
          terminal.options.disableStdin = true;
          setConnected(false);
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
      disposed = true; clearTimeout(reconnect); clearTimeout(copiedTimer.current); socket?.close(); input.dispose(); selection.dispose();
      resizeObserver.disconnect(); terminal.dispose(); terminalRef.current = null; fitRef.current = null;
    };
  }, [sessionId, running]);
  useEffect(() => { requestAnimationFrame(() => terminalRef.current?.focus()); }, [fullscreen]);

  const toggleLabel = fullscreen ? '退出全屏' : '全屏';
  return <div className={`terminal-pane ${fullscreen ? 'fullscreen' : ''}`}>
    <div className="terminal-toolbar"><span title={connected ? '浏览器已连接终端通道；任务是否执行请查看会话状态' : '正在连接终端通道'} className={`terminal-connection ${connected ? 'connected' : ''}`}><i />{connected ? '已连接' : '连接中'}</span><div>
      <button title="复制选中的终端内容" aria-label="复制选中的终端内容" onClick={async () => {
        const selected = terminalRef.current?.getSelection();
        if (!selected) { setError('先在终端中选中要复制的内容'); return; }
        try { await navigator.clipboard.writeText(selected); setCopied(true); setError(''); clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(false), 1800); }
        catch { setError('浏览器无法访问剪贴板，请使用系统复制快捷键'); }
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
      <button title="回到终端底部" aria-label="回到终端底部" onClick={() => { terminalRef.current?.scrollToBottom(); terminalRef.current?.focus(); }}><ArrowDownToLine size={14} /></button>
      <button title={`${toggleLabel}（Ctrl / ⌘ + Shift + Enter）`} aria-label={toggleLabel} aria-pressed={fullscreen} onClick={() => setFullscreen((value) => !value)}>{fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
    </div></div>
    {error && <div className="terminal-error" role="alert"><WifiOff size={14} /><span>{error}</span><button className="terminal-dismiss" aria-label="关闭终端提示" onClick={() => setError('')}><X size={13} /></button></div>}
    <div ref={containerRef} className="terminal-container" />
    {!running && <div className="terminal-hint">启动会话后，在这里使用原生 CLI。</div>}
  </div>;
}
