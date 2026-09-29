/** LAN pages over HTTP may not expose the modern clipboard API. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* Try the browser's selection-based copy fallback. */ }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  // Keep the temporary selection within an active modal's focus boundary.
  (focused?.closest('[role="dialog"]') ?? document.body).append(input);
  try {
    input.focus({ preventScroll: true }); input.select();
    if (!document.execCommand('copy')) throw new Error('浏览器无法访问剪贴板，请选中目录后手动复制');
  } finally {
    input.remove();
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection?.addRange(range);
  }
}
