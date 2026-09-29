import { memo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from './clipboard';
import 'highlight.js/styles/github.css';
import './markdown.css';

function safeLink(value: string) {
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value) || /^#[\w-]+$/.test(value)) return value;
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [result, setResult] = useState('');
  return <div className="markdown-code"><button type="button" aria-label="复制代码" title={result || '复制代码'} onClick={async () => {
    try { await copyToClipboard(ref.current?.textContent ?? ''); setResult('已复制'); }
    catch { setResult('无法复制，请选中代码后复制'); }
  }}>{result === '已复制' ? <Check size={13} /> : <Copy size={13} />}<span>{result || '复制'}</span></button><pre ref={ref}>{children}</pre></div>;
}

/** Native text is untrusted: no raw HTML, executable URLs or remote image loads. */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]} skipHtml urlTransform={safeLink} components={{
    a: ({ href, children }) => href ? <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span className="markdown-image-label">[图片{alt ? `：${alt}` : ''}]</span>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  }}>{text}</ReactMarkdown></div>;
});
export default Markdown;
