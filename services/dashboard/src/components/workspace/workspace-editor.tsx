"use client";
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth-store';
import { withBasePath } from '@/lib/base-path';
import { MeetingWikiSourceStatus } from '@/components/meetings/meeting-knowledge';
import { DocumentTree } from './document-tree';
import { WorkspaceHistory } from './workspace-history';
import { remarkWikiLinks } from './wiki-links';
import { savedDraft, storeDraft, hasDrafts } from './drafts';

interface Mount { slug: string; name?: string; role: string; write: boolean; primary?: boolean }
interface Document { content: string; sha256: string; writable: boolean }
interface MovePlan { fingerprint: string; path: string; destination: string; changes: Array<{ path: string; replacements: number; diff: string }>; warnings: string[] }
const protectDrafts = (e: BeforeUnloadEvent) => {
  if (hasDrafts()) { e.preventDefault(); e.returnValue = ''; }
};
export function WorkspaceEditor() {
  const owner = useAuthStore(s => String(s.user?.id || ''));
  return <Editor key={owner} owner={owner} />;
}
function Editor({ owner }: { owner: string }) {
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [slug, setSlug] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [contentSearch, setContentSearch] = useState(false);
  const [hits, setHits] = useState<Array<{ path: string; line: number; text: string }>>([]);
  const [searchStatus, setSearchStatus] = useState('');
  const [path, setPath] = useState('');
  const [doc, setDoc] = useState<Document | null>(null);
  const [draft, setDraft] = useState('');
  const [newPath, setNewPath] = useState('');
  const [movePath, setMovePath] = useState('');
  const [movePreview, setMovePreview] = useState<MovePlan | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [gitRevision, setGitRevision] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const ticket = useRef(0);
  const dirty = !!doc && draft !== doc.content;
  useEffect(() => { setMovePreview(null); }, [path, slug, doc?.sha256, movePath, dirty]);
  const draftKey = (target = path, targetSlug = slug) => JSON.stringify([owner, targetSlug, target]);
  function clearDraft(key: string) {
    if (!storeDraft(key)) setError('Không xóa được bản nháp trên trình duyệt. Hãy giữ tab này mở để kiểm tra trước khi tải lại.');
  }
  function address(target: string, targetSlug: string) {
    const url = new URL(window.location.href);
    if (target) url.searchParams.set('path', target); else url.searchParams.delete('path');
    if (targetSlug) url.searchParams.set('slug', targetSlug); else url.searchParams.delete('slug');
    window.history.replaceState(window.history.state, '', url);
  }
  useEffect(() => {
    if (!owner || !path || !doc) return;
    const key = JSON.stringify([owner, slug, path]);
    if (!storeDraft(key, dirty ? { text: draft, baseContent: doc.content, sha256: doc.sha256 } : undefined)) {
      setError('Không lưu được bản nháp trên trình duyệt. Hãy lưu tài liệu trước khi tải lại hoặc đóng tab.');
    }
    if (hasDrafts()) window.addEventListener('beforeunload', protectDrafts);
    else window.removeEventListener('beforeunload', protectDrafts);
  }, [owner, slug, path, doc, draft, dirty]);
  const query = (target = slug) => target ? `&slug=${encodeURIComponent(target)}` : '';
  useEffect(() => {
    setHits([]); setSearchStatus('');
    if (!contentSearch || !filter.trim()) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchStatus('Đang tìm trong nội dung…');
      void fetch(withBasePath(`/api/agent/workspace/search?q=${encodeURIComponent(filter.trim())}${query()}`), { cache: 'no-store', signal: abort.signal })
        .then(async response => {
          if (!response.ok) throw new Error('Không tìm được nội dung workspace.');
          const result = await response.json();
          if (!abort.signal.aborted) { setHits(result.hits); setSearchStatus(`${result.hits.length} kết quả · ${result.scanned} tài liệu${result.bounded ? ' · đã chạm giới hạn tìm kiếm' : ''}`); }
        }).catch(error => { if (!abort.signal.aborted) setSearchStatus(error.message); });
    }, 250);
    return () => { abort.abort(); window.clearTimeout(timer); };
  // Search always addresses the selected workspace.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentSearch, filter, slug]);
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
      if (id === ticket.current) {
        if (dirty) clearDraft(draftKey());
        const saved = savedDraft(draftKey(target, targetSlug));
        const restore = saved && saved.text !== data.content;
        setPath(target); setMovePath(''); setSlug(targetSlug); setPreview(true);
        setDoc(restore ? { content: saved.baseContent, sha256: saved.sha256, writable: data.writable } : data);
        setDraft(restore ? saved.text : data.content);
        address(target, targetSlug);
        if (restore) {
          setNotice('Đã khôi phục bản nháp chưa lưu trong tab này.');
          if (saved.sha256 !== data.sha256) setError('Tài liệu đã thay đổi. Bản nháp được giữ; tải lại tài liệu để dùng bản mới nhất.');
        }
      }
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
        const targetSlug = initialSlug || data.active?.find((m: Mount) => m.primary)?.slug || '';
        const next = await tree(targetSlug);
        if (abort.signal.aborted) return;
        setMounts(data.active || []); setFiles(next); setSlug(targetSlug);
        const initial = params.get('path');
        if (initial) await open(initial, targetSlug);
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    })();
    return () => { abort.abort(); ticket.current++; };
  // Initial URL state is consumed once; later navigation is explicit so unsaved drafts are preserved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function save(commit = false, creating = false) {
    const target = creating ? newPath.trim() : path;
    if (!target) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await fetch(withBasePath('/api/agent/workspace/document'), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target, content: creating ? '# ' + target.split('/').pop()?.replace(/\.md$/, '') : draft,
          expected_sha256: creating ? null : doc?.sha256, ...(slug ? { slug } : {}), commit,
          commit_message: commitMessage.trim() || 'Review Markdown document' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Không lưu được. Bản nháp vẫn được giữ.');
      if (creating) { setNewPath(''); await open(target); }
      else { setDoc(current => current ? { ...current, content: draft, sha256: data.sha256 } : current); }
      setFiles(await tree());
      setGitRevision(value => value + 1);
      setNotice(data.commit_error || (data.commit ? `Đã lưu và ghi phiên bản ${data.commit.slice(0, 8)}. Chưa đẩy lên remote.` : 'Đã lưu tài liệu.'));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function switchWorkspace(value: string) {
    if (dirty && !window.confirm('Bản nháp chưa lưu. Bạn muốn bỏ bản nháp để đổi workspace?')) return;
    value = value || mounts.find(m => m.primary)?.slug || '';
    ticket.current++; setBusy(true); setError('');
    try { const next = await tree(value); clearDraft(draftKey()); setSlug(value); setFiles(next); setPath(''); setDoc(null); setDraft(''); address('', value); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function changeFile(action: 'move' | 'delete') {
    if (!doc || dirty || (action === 'move' && (!movePath.trim() || !movePreview))) return;
    if (action === 'delete' && !window.confirm(`Xóa tài liệu ${path}? Thao tác này xóa file khỏi workspace.`)) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(withBasePath(`/api/agent/workspace/document/${action}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, slug, expected_sha256: doc.sha256, ...(action === 'move' ? { destination: movePath.trim(), update_links: true, expected_plan: movePreview!.fingerprint } : {}) }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.detail || 'Không thay đổi được tài liệu.');
      clearDraft(draftKey()); setFiles(await tree()); setGitRevision(value => value + 1);
      if (action === 'move') await open(value.path);
      else { setPath(''); setDoc(null); setDraft(''); address('', slug); }
      setNotice(action === 'move' ? `Đã di chuyển tài liệu và cập nhật ${value.updated_links || 0} liên kết.${value.warnings?.length ? ' Còn liên kết cần kiểm tra thủ công theo bản xem trước.' : ''}` : 'Đã xóa tài liệu.');
    } catch (error) { setMovePreview(null); setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function previewMove() {
    if (!doc || dirty || !movePath.trim()) return;
    setBusy(true); setError(''); setMovePreview(null);
    try {
      const response = await fetch(withBasePath('/api/agent/workspace/document/move/preview'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, slug, expected_sha256: doc.sha256, destination: movePath.trim() }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.detail || 'Không tạo được bản xem trước. Chưa có file nào bị thay đổi.');
      setMovePreview(value);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  function format(prefix: string, suffix = '') {
    const field = textarea.current;
    if (!field) return;
    const { selectionStart: start, selectionEnd: end } = field;
    setDraft(draft.slice(0, start) + prefix + draft.slice(start, end) + suffix + draft.slice(end));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + prefix.length, end + prefix.length); });
  }
  function follow(href: string) {
    let target: string | undefined;
    let reference = href;
    try { if (href.startsWith('#knowledge=')) reference = decodeURIComponent(href.slice(11)); }
    catch { setError('Liên kết tài liệu không hợp lệ.'); return; }
    if (href.startsWith('#knowledge=') && !reference.includes('/') && !/\.md(?:[?#]|$)/.test(reference)) {
      const title = reference.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      target = files.find(file => file.split('/').pop()?.replace(/\.md$/, '') === title);
    } else {
      target = /^(kg|wiki|notes|docs|sources|concepts)\//.test(reference) ? reference : new URL(reference, 'https://workspace.invalid/' + path).pathname.slice(1);
      target = target.split(/[?#]/)[0];
      try { target = decodeURIComponent(target); } catch { /* Keep literal filename characters. */ }
    }
    if (target) void open(target);
    else setError('Không tìm thấy tài liệu được liên kết trong workspace này.');
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
        <label className="block text-xs"><input type="checkbox" checked={contentSearch} onChange={e => setContentSearch(e.target.checked)} /> Tìm trong nội dung</label>
        <div className="max-h-48 overflow-auto md:max-h-none">{contentSearch && filter.trim() ? <>
          <p role="status" className="text-xs">{searchStatus}</p>{hits.map(hit => <button key={`${hit.path}:${hit.line}`} type="button" className="block w-full break-all p-2 text-left text-xs" disabled={busy} onClick={() => void open(hit.path)}><strong>{hit.path}:{hit.line}</strong><br />{hit.text}</button>)}
        </> : <DocumentTree files={files.filter(f => f.toLowerCase().includes(filter.toLowerCase()))} selected={path} onOpen={target => void open(target)} disabled={busy} />}</div>
        <label className="block text-sm">Tạo trang Markdown<Input aria-label="Đường dẫn trang mới" value={newPath} onChange={e => setNewPath(e.target.value)} placeholder="wiki/ghi-chu.md" /></label>
        <Button size="sm" disabled={busy || !newPath.trim() || dirty} onClick={() => void save(false, true)}>Tạo trang</Button>
      </aside>
      <section className="flex min-h-0 flex-col overflow-auto rounded border p-3">
        {path && doc ? <>
          <header className="mb-3 flex flex-wrap items-center gap-2"><strong className="break-all text-sm">{path}{dirty ? ' · có bản nháp' : ''}</strong>
            <Button size="sm" variant="outline" onClick={() => setPreview(!preview)}>{preview ? 'Sửa văn bản' : 'Xem trước'}</Button>
            <Button size="sm" disabled={busy || !doc.writable || !dirty} onClick={() => void save()}>Lưu</Button>
            <Button size="sm" variant="outline" disabled={busy || !doc.writable} onClick={() => void save(true)}>Lưu và ghi phiên bản</Button>
            <Input aria-label="Mô tả phiên bản" placeholder="Mô tả phiên bản (tùy chọn)" value={commitMessage} maxLength={200} onChange={e => setCommitMessage(e.target.value)} />
          </header>
          <MeetingWikiSourceStatus key={`${slug}/${path}`} path={path} content={doc.content} slug={slug || undefined} />
          <WorkspaceHistory slug={slug} path={path} revision={gitRevision} />
          {doc.writable && <details className="mb-3"><summary>Đổi tên, di chuyển hoặc xóa tài liệu</summary>
            <Input aria-label="Đường dẫn đích" placeholder="notes/ten-moi.md" value={movePath} disabled={busy} onChange={e => setMovePath(e.target.value)} />
            <Button size="sm" variant="outline" disabled={busy || dirty || !movePath.trim()} onClick={() => void previewMove()}>Đổi tên / di chuyển</Button>{' '}
            <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void changeFile('delete')}>Xóa tài liệu</Button>
            {dirty && <p className="text-xs">Lưu bản nháp trước khi đổi đường dẫn hoặc xóa.</p>}
            {movePreview && <section role="region" aria-label="Duyệt di chuyển và cập nhật liên kết" className="my-2 space-y-2 rounded border p-2">
              <p>{movePreview.path} → {movePreview.destination}</p>
              <p className="text-xs">{movePreview.changes.length} file cần cập nhật liên kết trong workspace này. Chỉ thay đổi sau khi bạn xác nhận.</p>
              {movePreview.warnings.map(warning => <p key={warning} role="status" className="text-sm text-destructive">{warning}</p>)}
              <div className="max-h-72 overflow-auto">{movePreview.changes.map(change => <div key={change.path}><strong className="text-xs">{change.path} · {change.replacements} liên kết</strong><pre className="overflow-auto whitespace-pre text-xs">{change.diff}</pre></div>)}</div>
              <Button size="sm" disabled={busy || dirty} onClick={() => void changeFile('move')}>Xác nhận di chuyển và cập nhật liên kết</Button>{' '}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setMovePreview(null)}>Hủy di chuyển</Button>
            </section>}
          </details>}
          {!doc.writable && <p className="text-xs text-muted-foreground">Tài liệu này chỉ đọc tại đây.</p>}
          {preview ? <div className="prose prose-sm dark:prose-invert max-w-none overflow-auto"><ReactMarkdown remarkPlugins={[remarkGfm, remarkWikiLinks]} components={{ a: ({ href, children }) => {
            const internal = href && (href.startsWith('#knowledge=') || (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href) && /\.md(?:[?#]|$)/.test(href)));
            return <a href={href} onClick={internal ? e => { e.preventDefault(); follow(href!); } : undefined}>{children}</a>;
          } }}>{draft.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')}</ReactMarkdown></div>
            : <><div role="toolbar" aria-label="Định dạng Markdown" className="mb-2 flex gap-2">{[['Đậm', '**', '**'], ['Nghiêng', '*', '*'], ['Tiêu đề', '## ', ''], ['Danh sách', '- ', ''], ['Mã', '`', '`']].map(([label, prefix, suffix]) => <Button key={label} size="sm" variant="outline" disabled={!doc.writable || busy} onClick={() => format(prefix, suffix)}>{label}</Button>)}</div>
              <textarea ref={textarea} aria-label="Nội dung tài liệu" className="min-h-80 flex-1 resize-none bg-background p-2 font-mono text-sm" value={draft} onChange={e => setDraft(e.target.value)} readOnly={!doc.writable || busy} /></>}
        </> : <p className="text-muted-foreground">Chọn tài liệu để đọc, hoặc mở trang Wiki từ một cuộc họp.</p>}
      </section>
    </div>
  </div>;
}
