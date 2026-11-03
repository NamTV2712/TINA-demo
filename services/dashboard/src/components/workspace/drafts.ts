export interface WorkspaceDraft { text: string; baseContent: string; sha256: string }
const memory = new Map<string, WorkspaceDraft>();
const prefix = 'tina.workspace-draft:';

export function savedDraft(key: string): WorkspaceDraft | undefined {
  const cached = memory.get(key);
  if (cached) return cached;
  let raw: string | null;
  try { raw = sessionStorage.getItem(prefix + key); } catch { return; }
  if (!raw) return;
  const value = JSON.parse(raw);
  if (!value || typeof value.text !== 'string' || typeof value.baseContent !== 'string'
      || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error('Bản nháp cục bộ không hợp lệ. Dữ liệu được giữ để khôi phục.');
  }
  memory.set(key, value);
  return value;
}

export function storeDraft(key: string, value?: WorkspaceDraft): boolean {
  if (value) memory.set(key, value);
  else memory.delete(key);
  try {
    if (value) sessionStorage.setItem(prefix + key, JSON.stringify(value));
    else sessionStorage.removeItem(prefix + key);
    return true;
  } catch { return false; }
}

export const hasDrafts = () => memory.size > 0;
