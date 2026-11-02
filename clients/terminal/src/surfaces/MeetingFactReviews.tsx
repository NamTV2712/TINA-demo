"use client";
import { useEffect, useState } from 'react';

export interface FactItem {
  fact: { id: string; type: string; text: string; evidence: Array<{ segment_id: string; quote: string; speaker_name: string; start_ms: number }> };
  fingerprint: string; stale: boolean;
  review: { revision: number; status: string; text: string } | null;
}
export function MeetingFactReviews({ meetingId, items, verified, onRefresh }: { meetingId: string; items: FactItem[]; verified: boolean; onRefresh: () => Promise<unknown> }) {
  return <details className="mt-3"><summary>Quyết định và công việc cần duyệt ({items.length})</summary>
    {items.length === 0 && <p className="my-2 text-muted-foreground">Chưa có đề xuất từ transcript đã xác nhận.</p>}
    <div className="max-h-96 overflow-auto">{items.map(item => <Review key={item.fact.id} item={item} meetingId={meetingId} verified={verified} onRefresh={onRefresh} />)}</div>
  </details>;
}
function Review({ item, meetingId, verified, onRefresh }: { item: FactItem; meetingId: string; verified: boolean; onRefresh: () => Promise<unknown> }) {
  const current = { revision: item.review?.revision || 0, text: item.review?.text || item.fact.text };
  const [base, setBase] = useState(current);
  const [text, setText] = useState(current.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (text === base.text) { setBase(current); setText(current.text); }
  // A dirty draft retains its original revision and becomes a visible conflict instead of being replaced.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.revision, current.text]);
  const conflict = current.revision !== base.revision;
  async function review(status: string) {
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/workspace/meeting-knowledge/${encodeURIComponent(meetingId)}/facts/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact_id: item.fact.id, expected_fingerprint: item.fingerprint,
          expected_revision: base.revision, text, status }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.detail || 'Không lưu được đánh giá.');
      setBase({ revision: result.revision, text: result.text }); setText(result.text);
      await onRefresh();
    } catch (e) { await onRefresh(); setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const labels: Record<string, string> = { approved: 'Đã duyệt', discarded: 'Đã bỏ', pending: 'Chờ duyệt' };
  return <article className="my-3 space-y-2 rounded-md border p-3">
    <strong>{item.fact.type === 'action_item' ? 'Công việc' : item.fact.type === 'decision' ? 'Quyết định' : 'Thông tin'} · {labels[item.review?.status || 'pending']}</strong>
    {item.stale && <p role="status" className="text-destructive">Nguồn đã thay đổi. Đánh giá cũ cần được kiểm tra lại.</p>}
    <textarea style={{ width: '100%', minHeight: 70 }} aria-label="Nội dung đề xuất" value={text} onChange={e => setText(e.target.value)} maxLength={4000} disabled={busy || item.stale} />
    {item.fact.evidence.map(e => <blockquote key={e.segment_id} className="border-l-2 pl-3 text-muted-foreground"><p>{e.quote}</p><small>{e.speaker_name} · {e.start_ms > 1e12 ? new Date(e.start_ms).toLocaleTimeString() : `${Math.floor(e.start_ms / 60000)}:${String(Math.floor(e.start_ms / 1000) % 60).padStart(2, '0')}`}</small></blockquote>)}
    {conflict && <p role="alert">Đánh giá đã được sửa ở nơi khác; bản nháp của bạn được giữ. <button className="underline" onClick={() => { setBase(current); setText(current.text); }}>Dùng bản mới nhất</button></p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">{[['approved', 'Duyệt'], ['discarded', 'Bỏ đề xuất'], ['pending', 'Mở lại']].map(([status, label]) => <button type="button" key={status} disabled={busy || !verified || item.stale || conflict || !text.trim()} onClick={() => void review(status)}>{label}</button>)}</div>
    <p className="text-xs text-muted-foreground">Đánh giá này được lưu riêng; câu chữ gốc trong transcript được giữ nguyên.</p>
  </article>;
}
