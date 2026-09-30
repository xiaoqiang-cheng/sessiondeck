import { Fragment, useMemo, type ReactNode } from 'react';

// A VS Code style renderer for one file of `git diff` unified output. The
// server keeps the raw text bounded; this module only parses and lays it out.

export type DiffMode = 'split' | 'inline';
type Line = { kind: 'context' | 'added' | 'removed'; text: string; oldNo?: number; newNo?: number; noNewline?: boolean };
type Hunk = { header: string; section: string; lines: Line[] };
type ParsedDiff = { hunks: Hunk[]; added: number; removed: number; binary: boolean; meta: string[] };
type Side = { no?: number; text: string; kind: Line['kind'] | 'empty'; words?: ReactNode };
type SplitRow = { left: Side; right: Side };

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const result: ParsedDiff = { hunks: [], added: 0, removed: 0, binary: false, meta: [] };
  let hunk: Hunk | null = null;
  let oldNo = 0, newNo = 0;
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (header) {
      oldNo = Number(header[1]); newNo = Number(header[2]);
      hunk = { header: line.slice(0, line.length - header[3].length).trim(), section: header[3], lines: [] };
      result.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^Binary files .* differ$/.test(line)) result.binary = true;
      else if (/^(?:new file mode|deleted file mode|old mode|new mode)/.test(line)) result.meta.push(line);
      continue;
    }
    if (line.startsWith('\\')) { const last = hunk.lines.at(-1); if (last) last.noNewline = true; continue; }
    const sign = line[0];
    if (sign === '+') { hunk.lines.push({ kind: 'added', text: line.slice(1), newNo: newNo++ }); result.added++; }
    else if (sign === '-') { hunk.lines.push({ kind: 'removed', text: line.slice(1), oldNo: oldNo++ }); result.removed++; }
    else if (sign === ' ') hunk.lines.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    // A trailing empty string after the final newline, or a truncated line, ends the hunk.
  }
  return result;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
/** Word level changes for one paired removed/added line, as VS Code highlights them. */
function wordDiff(before: string, after: string): [ReactNode, ReactNode] | null {
  const a = before.match(TOKEN) ?? [], b = after.match(TOKEN) ?? [];
  // Very long lines keep whole-line highlighting instead of an expensive LCS.
  if (!a.length || !b.length || a.length * b.length > 60_000) return null;
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  // Unrelated lines would be almost entirely highlighted; plain colors read better.
  if (table[0][0] * 3 < Math.min(a.length, b.length)) return null;
  // Adjacent changed tokens merge into one highlighted range.
  const left: { text: string; changed: boolean }[] = [], right: typeof left = [];
  const push = (target: typeof left, text: string, changed: boolean) => {
    const last = target.at(-1);
    if (last && last.changed === changed) last.text += text; else target.push({ text, changed });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push(left, a[i], false); push(right, b[j], false); i++; j++; }
    else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) push(right, b[j++], true);
    else push(left, a[i++], true);
  }
  // A lone space between two changes reads as one edit, as in VS Code.
  const joinGaps = (segments: typeof left) => segments.reduce<typeof left>((result, segment, index) => {
    const previous = result.at(-1), next = segments[index + 1];
    if (!segment.changed && /^\s+$/.test(segment.text) && previous?.changed && next?.changed) previous.text += segment.text;
    else if (segment.changed && previous?.changed) previous.text += segment.text;
    else result.push({ ...segment });
    return result;
  }, []);
  const render = (segments: typeof left) => segments.map((segment, index) => segment.changed ? <mark key={index}>{segment.text}</mark> : <Fragment key={index}>{segment.text}</Fragment>);
  return [render(joinGaps(left)), render(joinGaps(right))];
}

function splitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const empty: Side = { text: '', kind: 'empty' };
  for (let index = 0; index < hunk.lines.length;) {
    const line = hunk.lines[index];
    if (line.kind === 'context') {
      rows.push({ left: { no: line.oldNo, text: line.text, kind: 'context' }, right: { no: line.newNo, text: line.text, kind: 'context' } });
      index++; continue;
    }
    const removed: Line[] = [], added: Line[] = [];
    while (hunk.lines[index]?.kind === 'removed') removed.push(hunk.lines[index++]);
    while (hunk.lines[index]?.kind === 'added') added.push(hunk.lines[index++]);
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) {
      const before = removed[pair], after = added[pair];
      const words = before && after ? wordDiff(before.text, after.text) : null;
      rows.push({
        left: before ? { no: before.oldNo, text: before.text, kind: 'removed', words: words?.[0] } : empty,
        right: after ? { no: after.newNo, text: after.text, kind: 'added', words: words?.[1] } : empty,
      });
    }
  }
  return rows;
}

function inlineWords(hunk: Hunk) {
  // Pair change blocks the same way as the split view so both modes agree.
  const words = new Map<Line, ReactNode>();
  for (let index = 0; index < hunk.lines.length;) {
    if (hunk.lines[index].kind === 'context') { index++; continue; }
    const removed: Line[] = [], added: Line[] = [];
    while (hunk.lines[index]?.kind === 'removed') removed.push(hunk.lines[index++]);
    while (hunk.lines[index]?.kind === 'added') added.push(hunk.lines[index++]);
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair++) {
      const result = wordDiff(removed[pair].text, added[pair].text);
      if (result) { words.set(removed[pair], result[0]); words.set(added[pair], result[1]); }
    }
  }
  return words;
}

function HunkHeader({ hunk, columns }: { hunk: Hunk; columns: number }) {
  return <tr className="diff-hunk"><td colSpan={columns}><span>{hunk.header}</span>{hunk.section && <em>{hunk.section}</em>}</td></tr>;
}

export function DiffStats({ diff }: { diff: string }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  return <span className="diff-stats"><b className="diff-stat-added">+{parsed.added}</b><b className="diff-stat-removed">−{parsed.removed}</b></span>;
}

export default function DiffView({ diff, mode }: { diff: string; mode: DiffMode }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const split = useMemo(() => mode === 'split' ? parsed.hunks.map(splitRows) : null, [parsed, mode]);
  const inline = useMemo(() => mode === 'inline' ? parsed.hunks.map(inlineWords) : null, [parsed, mode]);
  if (parsed.binary) return <p className="workspace-note">二进制文件已更改，不显示文本差异。</p>;
  if (!parsed.hunks.length) return <p className="workspace-note">{parsed.meta.length ? parsed.meta.join('\n') : '此文件没有可显示的文本差异。'}</p>;
  return <div className={`diff-view diff-${mode}`}>
    <table aria-label={mode === 'split' ? '并排差异' : '内联差异'}>
      {mode === 'split' ? <colgroup><col className="diff-col-no" /><col /><col className="diff-col-no" /><col /></colgroup> : <colgroup><col className="diff-col-no" /><col className="diff-col-no" /><col className="diff-col-sign" /><col /></colgroup>}
      <tbody>
        {parsed.hunks.map((hunk, hunkIndex) => <Fragment key={hunkIndex}>
          <HunkHeader hunk={hunk} columns={4} />
          {split ? split[hunkIndex].map((row, index) => <tr key={index} className="diff-row">
            <td className={`diff-no diff-${row.left.kind}`}>{row.left.no}</td>
            <td className={`diff-code diff-${row.left.kind}`}>{row.left.words ?? row.left.text}</td>
            <td className={`diff-no diff-split-right diff-${row.right.kind}`}>{row.right.no}</td>
            <td className={`diff-code diff-${row.right.kind}`}>{row.right.words ?? row.right.text}</td>
          </tr>) : hunk.lines.map((line, index) => <tr key={index} className={`diff-row diff-${line.kind}`}>
            <td className="diff-no">{line.oldNo}</td>
            <td className="diff-no">{line.newNo}</td>
            <td className="diff-sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</td>
            <td className="diff-code">{inline![hunkIndex].get(line) ?? line.text}{line.noNewline && <small className="diff-no-newline">⊘ 文件末尾没有换行</small>}</td>
          </tr>)}
        </Fragment>)}
      </tbody>
    </table>
  </div>;
}
