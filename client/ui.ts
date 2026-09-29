import { useEffect, useRef, type RefObject } from 'react';

export function readLocalPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeLocalPreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Storage may be disabled by the browser. */ }
}

const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],iframe,summary,[tabindex]:not([tabindex="-1"])';
let scrollLocks = 0;
let previousOverflow = '';

/** Keep application chrome accessible while preserving native terminal key handling. */
export function useDialog(ref: RefObject<HTMLElement | null>, active: boolean, close: () => void, preserveTerminal = false) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scrollLocks++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    const focusables = () => [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((element) => !element.closest('[inert]') && element.getClientRects().length > 0);
    const timer = setTimeout(() => {
      // Initial focus must not steal a user's rapid click or typing, nor jump
      // back into a form while its nested directory picker is active.
      if (!ref.current || ref.current.inert || ref.current.contains(document.activeElement)) return;
      const preferred = ref.current?.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled),select:not(:disabled)');
      (preferred ?? focusables()[0] ?? ref.current)?.focus();
    }, 30);
    const onKey = (event: KeyboardEvent) => {
      if (!ref.current || ref.current.inert) return;
      if (preserveTerminal && event.target instanceof HTMLElement && event.target.closest('.terminal-pane')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes.length) { event.preventDefault(); ref.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === nodes[0] || !ref.current.contains(document.activeElement))) {
        event.preventDefault(); nodes.at(-1)?.focus();
      } else if (!event.shiftKey && (document.activeElement === nodes.at(-1) || !ref.current.contains(document.activeElement))) {
        event.preventDefault(); nodes[0].focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer); document.removeEventListener('keydown', onKey);
      if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
      // React removes inert on the background during the same commit.
      queueMicrotask(() => { if (previous?.isConnected && !previous.closest('[inert]')) previous.focus(); });
    };
  }, [active, preserveTerminal, ref]);
}
