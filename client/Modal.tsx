import { useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialog } from './ui';

export default function ModalShell({ title, subtitle, close, children, wide = false }: { title: string; subtitle?: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, true, close);
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭" onClick={close}><X size={20} /></button></div>{children}
  </div></div>;
}
