import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const data = new Map<string, string>();
beforeEach(() => {
  data.clear(); vi.resetModules();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
const draft = { text: 'Unsaved edit', baseContent: 'Original server content', sha256: 'a'.repeat(64) };
const key = JSON.stringify(['owner', 'home', 'wiki/a.md']);

it('restores a draft and its original save precondition after a fresh module load', async () => {
  const first = await import('../src/components/workspace/drafts');
  expect(first.storeDraft(key, draft)).toBe(true);
  vi.resetModules();
  const reloaded = await import('../src/components/workspace/drafts');
  expect(reloaded.savedDraft(key)).toEqual(draft);
  expect(reloaded.hasDrafts()).toBe(true);
  expect(reloaded.savedDraft(JSON.stringify(['other-owner', 'home', 'wiki/a.md']))).toBeUndefined();
  expect(reloaded.savedDraft(JSON.stringify(['owner', 'other-workspace', 'wiki/a.md']))).toBeUndefined();
});
it('removes saved or explicitly discarded drafts across reloads', async () => {
  const module = await import('../src/components/workspace/drafts');
  module.storeDraft(key, draft); module.storeDraft(key);
  vi.resetModules();
  expect((await import('../src/components/workspace/drafts')).savedDraft(key)).toBeUndefined();
});
it('retains the in-memory draft and reports a storage failure', async () => {
  const module = await import('../src/components/workspace/drafts');
  vi.stubGlobal('sessionStorage', { setItem: () => { throw new Error('Quota exceeded'); } });
  expect(module.storeDraft(key, draft)).toBe(false);
  expect(module.savedDraft(key)).toEqual(draft);
});
it('rejects corrupt persisted state without deleting the recovery data', async () => {
  data.set('tina.workspace-draft:' + key, '{broken');
  const module = await import('../src/components/workspace/drafts');
  expect(() => module.savedDraft(key)).toThrow();
  expect(data.get('tina.workspace-draft:' + key)).toBe('{broken');
});
