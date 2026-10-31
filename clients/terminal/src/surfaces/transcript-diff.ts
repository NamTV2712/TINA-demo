/** Whitespace-token diff; bound memory for long legacy transcripts. */
export function transcriptDiff(before: string, after: string): Array<{ kind: 'keep' | 'add' | 'remove'; text: string }> {
  const a = before.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
  const b = after.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
  if (a.length * b.length > 250000) return [{ kind: 'remove', text: before }, { kind: 'add', text: after }];
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const result: Array<{ kind: 'keep' | 'add' | 'remove'; text: string }> = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: 'keep', text: a[i++] }); j++; }
    else if (j < b.length && (i === a.length || rows[i][j + 1] >= rows[i + 1][j])) result.push({ kind: 'add', text: b[j++] });
    else result.push({ kind: 'remove', text: a[i++] });
  }
  return result;
}
