"use client";
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth-store';
import { withBasePath } from '@/lib/base-path';
import { MeetingWikiSourceStatus } from '@/components/meetings/meeting-knowledge';

interface Mount { slug: string; name?: string; role: string; write: boolean }
interface Document { content: string; sha256: string; writable: boolean }
export function WorkspaceEditor() {
  const owner = useAuthStore(s => String(s.user?.id || ''));
  return <Editor key={owner} />;
}
function Editor() {
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [slug, setSlug] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [path, setPath] = useState('');
  const [doc, setDoc] = useState<Document | null>(null);
  const [draft, setDraft] = useState('');
  const [newPath, setNewPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const ticket = useRef(0);
  const dirty = !!doc && draft !== doc.content;
  const query = (target = slug) => target ? `&slug=${encodeURIComponent(target)}` : '';
  async function tree(target = slug) {
    const r = await fetch(withBasePath(`/api/agent/workspace/tree?${target ? `slug=${encodeURIComponent(target)}` : ''}`), { cache: 'no-store' });
    if (!r.ok) throw new Error('Không đọc được workspace. Kiểm tra đăng nhập hoặc quyền truy cập.');
    return (await r.json()).files as string[];
  }
  async function open(target: string, targetSlug = slug) {
    if (dirty && !window.confirm('Bản nháp chưa lưu. Bạn muốn bỏ bản nháp để mở tài liệu khác?')) return;
    const id = ++ticket.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await fetch(withBasePath(`/api/agent/workspace/document?path=${encodeURIComponent(target)}${query(targetSlug)}`), { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Không đọc được tài liệu.');
      if (id === ticket.current) { setPath(target); setSlug(targetSlug); setDoc(data); setDraft(data.content); setPreview(true); }
    } catch (e) { if (id === ticket.current) setError((e as Error).message); }
    finally { if (id === ticket.current) setBusy(false); }
  }
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams(window.location.search), initialSlug = params.get('slug') || '';
    setSlug(initialSlug);
    void (async () => {
      try {
        const r = await fetch(withBasePath('/api/agent/workspace/active'), { signal: abort.signal });
        if (!r.ok) throw new Error('Không đọc được danh sách workspace.');
        const data = await r.json();
        const next = await tree(initialSlug);
        if (abort.signal.aborted) return;
        setMounts(data.active || []); setFiles(next);
        const initial = params.get('path');
        if (initial) await open(initial, initialSlug);
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    })();
    return () => { abort.abort(); ticket.current++; };
  // Initial URL state is consumed once; later navigation is explicit so unsaved drafts are preserved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const protect = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  async function save(commit = false, creating = false) {
    const target = creating ? newPath.trim() : path;
    if (!target) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await fetch(withBasePath('/api/agent/workspace/document'), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target, content: creating ? '# ' + target.split('/').pop()?.replace(/\.md$/, '') : draft,
          expected_sha256: creating ? null : doc?.sha256, ...(slug ? { slug } : {}), commit }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Không lưu được. Bản nháp vẫn được giữ.');
      if (creating) { setNewPath(''); await open(target); }
      else { setDoc(current => current ? { ...current, content: draft, sha256: data.sha256 } : current); }
      setFiles(await tree());
      setNotice(data.commit_error || (data.commit ? `Đã lưu và ghi phiên bản ${data.commit.slice(0, 8)}. Chưa đẩy lên remote.` : 'Đã lưu tài liệu.'));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function switchWorkspace(value: string) {
    if (dirty && !window.confirm('Bản nháp chưa lưu. Bạn muốn bỏ bản nháp để đổi workspace?')) return;
    ticket.current++; setBusy(true); setError('');
    try { const next = await tree(value); setSlug(value); setFiles(next); setPath(''); setDoc(null); setDraft(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="flex h-full min-h-0 flex-col gap-3">
    <div className="flex flex-wrap gap-2 items-center"><h1 className="text-xl font-semibold">Wiki & Workspace</h1>
      <select aria-label="Workspace" className="rounded border bg-background p-2 text-sm" value={slug} disabled={busy} onChange={e => void switchWorkspace(e.target.value)}>
        <option value="">Workspace chính</option>{mounts.map(m => <option key={m.slug} value={m.slug}>{m.name || m.slug}{!m.write ? ' · chỉ đọc' : ''}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void tree().then(setFiles).catch(e => setError(e.message))}>Tải lại danh sách</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error} {path && <button className="underline" disabled={busy} onClick={() => void open(path)}>Tải lại tài liệu</button>}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[240px_1fr]">
      <aside className="overflow-auto rounded border p-2 space-y-2">
        <Input aria-label="Tìm tài liệu" placeholder="Tìm tài liệu…" value={filter} onChange={e => setFilter(e.target.value)} />
        <div className="max-h-48 overflow-auto md:max-h-none">{files.filter(f => f.toLowerCase().includes(filter.toLowerCase())).map(f => <button key={f} className={`block w-full break-all rounded p-2 text-left text-xs hover:bg-muted ${path === f ? 'bg-muted' : ''}`} disabled={busy} onClick={() => void open(f)}>{f}</button>)}</div>
        <label className="block text-sm">Tạo trang Markdown<Input aria-label="Đường dẫn trang mới" value={newPath} onChange={e => setNewPath(e.target.value)} placeholder="wiki/ghi-chu.md" /></label>
        <Button size="sm" disabled={busy || !newPath.trim() || dirty} onClick={() => void save(false, true)}>Tạo trang</Button>
      </aside>
      <section className="flex min-h-0 flex-col overflow-auto rounded border p-3">
        {path && doc ? <>
          <header className="mb-3 flex flex-wrap items-center gap-2"><strong className="break-all text-sm">{path}{dirty ? ' · có bản nháp' : ''}</strong>
            <Button size="sm" variant="outline" onClick={() => setPreview(!preview)}>{preview ? 'Sửa văn bản' : 'Xem trước'}</Button>
            <Button size="sm" disabled={busy || !doc.writable || !dirty} onClick={() => void save()}>Lưu</Button>
            <Button size="sm" variant="outline" disabled={busy || !doc.writable} onClick={() => void save(true)}>Lưu và ghi phiên bản</Button>
          </header>
          <MeetingWikiSourceStatus key={`${slug}/${path}`} path={path} slug={slug || undefined} />
          {!doc.writable && <p className="text-xs text-muted-foreground">Tài liệu này chỉ đọc tại đây.</p>}
          {preview ? <div className="prose prose-sm dark:prose-invert max-w-none overflow-auto"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')}</ReactMarkdown></div>
            : <textarea aria-label="Nội dung tài liệu" className="min-h-80 flex-1 resize-none bg-background p-2 font-mono text-sm" value={draft} onChange={e => setDraft(e.target.value)} readOnly={!doc.writable || busy} />}
        </> : <p className="text-muted-foreground">Chọn tài liệu để đọc, hoặc mở trang Wiki từ một cuộc họp.</p>}
      </section>
    </div>
  </div>;
}
