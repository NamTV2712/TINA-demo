"use client";
import { useEffect, useRef, useState } from 'react';
import { invalidateDocLinkCaches, useOpenEntity } from '../ui-kit/docLinks';

interface Draft {
  id: string; kind: 'task' | 'decision'; title: string; details: string;
  status: 'pending' | 'approved' | 'discarded'; revision: number; path: string | null;
}
const button = { padding: '6px 10px', borderRadius: 6, border: '1px solid var(--line2)',
  background: 'var(--panel2)', color: 'var(--t1)', cursor: 'pointer', fontSize: 12 } as const;
const input = { width: '100%', boxSizing: 'border-box', padding: 7, borderRadius: 6,
  border: '1px solid var(--line2)', background: 'var(--bg)', color: 'var(--t1)' } as const;

function DraftReview({ draft, base, verified, refresh }: { draft: Draft; base: string; verified: boolean; refresh: () => Promise<void> }) {
  const [title, setTitle] = useState(draft.title), [details, setDetails] = useState(draft.details);
  const [assignee, setAssignee] = useState(''), [due, setDue] = useState('');
  const [revision] = useState(draft.revision);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const openDoc = useOpenEntity();
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function review(status: 'approved' | 'discarded') {
    if (busy || !verified || draft.revision !== revision) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`${base}/${draft.id}/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: revision,
          status, title, details, assignee_label: assignee, due: due || null }) });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : 'Không lưu được bản nháp.');
      if (!active.current) return;
      if (status === 'approved' && draft.kind === 'task') window.dispatchEvent(new Event('tina:tasks-changed'));
      invalidateDocLinkCaches(); await refresh();
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : 'Không lưu được bản nháp.'); }
    finally { if (active.current) setBusy(false); }
  }
  return <article style={{ padding: '10px 0', borderTop: '1px solid var(--line2)' }}>
    <strong>{draft.kind === 'task' ? 'Task' : 'Quyết định'} · {draft.status === 'pending' ? 'Chờ chủ meeting xác nhận' : draft.status === 'approved' ? 'Đã lưu' : 'Đã bỏ'}</strong>
    {draft.status === 'pending' ? <form onSubmit={e => { e.preventDefault(); void review('approved'); }} style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      <label>Tiêu đề<input aria-label="Tiêu đề bản nháp voice" style={input} maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Nội dung<textarea aria-label="Nội dung bản nháp voice" style={input} rows={3} maxLength={10000} value={details} onChange={e => setDetails(e.target.value)} /></label>
      {draft.kind === 'task' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <label style={{ flex: '1 1 150px' }}>Người phụ trách (tùy chọn)<input aria-label="Người phụ trách task" style={input} maxLength={128} value={assignee} onChange={e => setAssignee(e.target.value)} /></label>
        <label>Hạn (tùy chọn)<input aria-label="Hạn task" type="date" style={input} value={due} onChange={e => setDue(e.target.value)} /></label>
      </div>}
      {draft.revision !== revision && <p role="status">Bản nháp đã thay đổi ở nơi khác. Nội dung bạn nhập vẫn được giữ; hãy tải lại để xem bản mới.</p>}
      {error && <p role="alert">{error}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={button} disabled={busy || !verified || draft.revision !== revision || !title.trim() || !details.trim()}>{draft.kind === 'task' ? 'Xác nhận tạo task' : 'Xác nhận ghi quyết định'}</button>
        <button type="button" style={button} disabled={busy || !verified || draft.revision !== revision} onClick={() => void review('discarded')}>Bỏ bản nháp</button>
      </div>
    </form> : <p>{draft.title} {draft.path && <button type="button" style={button} onClick={() => openDoc({ path: draft.path! })}>Mở tài liệu</button>}</p>}
  </article>;
}

export function MeetingVoiceDrafts({ meetingId }: { meetingId: string }) {
  const [drafts, setDrafts] = useState<Draft[]>([]), [verified, setVerified] = useState(false), [error, setError] = useState('');
  const refresh = useRef<() => Promise<void>>(async () => {});
  const base = `/api/workspace/meeting-knowledge/${encodeURIComponent(meetingId)}/voice-drafts`;
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>, serial = 0;
    setDrafts([]); setVerified(false); setError('');
    async function load() {
      const ticket = ++serial;
      try {
        const response = await fetch(base, { cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error('Chưa kiểm tra được bản nháp voice.');
        const value = await response.json();
        if (!abort.signal.aborted && ticket === serial) { setDrafts(value.drafts || []); setVerified(true); setError(''); }
      } catch (e) { if (!abort.signal.aborted && ticket === serial) { setVerified(false); setError(e instanceof Error ? e.message : 'Không đọc được bản nháp.'); } }
    }
    async function poll() { await load(); if (!abort.signal.aborted) timer = setTimeout(poll, 3000); }
    refresh.current = load; void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [base]);
  if (!drafts.length) return error ? <p role="status">{error}</p> : null;
  return <details open={drafts.some(d => d.status === 'pending')} style={{ marginTop: 12 }}>
    <summary>Bản nháp từ voice ({drafts.filter(d => d.status === 'pending').length} chờ xác nhận)</summary>
    <p style={{ color: 'var(--t3)' }}>Bản nháp theo yêu cầu trong phòng. Chủ meeting kiểm tra trước khi lưu task hoặc quyết định vào workspace.</p>
    {error && <p role="alert">{error}</p>}
    {drafts.map(d => <DraftReview key={`${meetingId}:${d.id}`} draft={d} base={base} verified={verified} refresh={() => refresh.current()} />)}
  </details>;
}
