"use client";
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth-store';
import { withBasePath } from '@/lib/base-path';
import { readAgentTurn } from '@/lib/agent-chat-stream';

interface Message { role: 'user' | 'assistant'; text: string }
interface Session { session: string; title?: string }
function rememberSession(session: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('agentSession', session);
  window.history.replaceState(window.history.state, '', url);
}
export function AgentChat({ meetingId, platform }: { meetingId?: string; platform?: string }) {
  const owner = useAuthStore(s => String(s.user?.id || ''));
  return <Chat key={`${owner}/${meetingId || ''}`} meetingId={meetingId} platform={platform} />;
}
function Chat({ meetingId, platform }: { meetingId?: string; platform?: string }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState(() => meetingId ? `dashboard-meeting-${meetingId}` : `dashboard-${crypto.randomUUID()}`);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [research, setResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  async function list() {
    const r = await fetch(withBasePath('/api/agent/sessions'), { cache: 'no-store' });
    if (!r.ok) throw new Error('Không đọc được các cuộc trò chuyện.');
    const rows: Session[] = (await r.json()).sessions || [];
    setSessions(rows);
    return rows;
  }
  useEffect(() => {
    let alive = true;
    const ticket = ++generation.current;
    setBusy(true);
    void list().then(async rows => {
      if (!alive) return;
      const saved = new URL(window.location.href).searchParams.get('agentSession');
      const target = rows.find(row => row.session === saved)?.session || rows.find(row => row.session === session)?.session;
      if (target) await select(target);
      else rememberSession(session);
    }).catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive && ticket === generation.current) setBusy(false); });
    return () => { alive = false; generation.current++; controller.current?.abort(); };
  }, []);
  useEffect(() => { setResearch(false); }, [session]);
  useEffect(() => { scroller.current?.scrollTo?.(0, scroller.current.scrollHeight); }, [messages]);
  async function select(id: string) {
    const ticket = ++generation.current;
    setSession(id); setMessages([]); setError(''); setBusy(true);
    rememberSession(id);
    try {
      const r = await fetch(withBasePath(`/api/agent/sessions/${encodeURIComponent(id)}/history`), { cache: 'no-store' });
      if (!r.ok) throw new Error('Không tải được lịch sử.');
      const data = await r.json();
      if (ticket === generation.current) setMessages((data.turns || []).map((t: {role: string; text: string}) => ({ role: t.role === 'user' ? 'user' : 'assistant', text: t.role === 'user' && t.text.includes('<!--tina:user-input-below-->') ? t.text.split('<!--tina:user-input-below-->').slice(1).join('<!--tina:user-input-below-->').trim() : t.text })));
    } catch (e) { if (ticket === generation.current) setError((e as Error).message); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  async function send() {
    if (busy || !input.trim()) return;
    const text = input.trim(), ticket = ++generation.current;
    setInput(''); setError(''); setBusy(true);
    setMessages(current => [...current, { role: 'user', text }, { role: 'assistant', text: '' }]);
    const abort = new AbortController(); controller.current = abort;
    let answer = '';
    const update = (value: string) => { if (ticket === generation.current) setMessages(current => [...current.slice(0, -1), { role: 'assistant', text: value }]); };
    try {
      await readAgentTurn({ prompt: text, session, ...(research ? { research: true } : {}),
        context: { focus: meetingId ? { kind: 'meeting', native_id: meetingId, meeting_id: meetingId, platform } : null, include: { schedule: false } },
      }, abort.signal, event => {
        if (event.type === 'message-delta') { answer += event.text || ''; update(answer); }
        if (event.type === 'done' && event.ok !== false && typeof event.reply === 'string') { answer = event.reply; update(answer); }
      });
      if (ticket === generation.current) await list();
    } catch (e) { if (ticket === generation.current) setError(abort.signal.aborted ? 'Đã dừng xem phản hồi. Tác vụ trên server có thể vẫn chạy; mở lại lịch sử để kiểm tra.' : (e as Error).message); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  async function reset() {
    try {
      const r = await fetch(withBasePath('/api/agent/chat/reset'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session }) });
      if (!r.ok) throw new Error('Không đặt lại được cuộc trò chuyện.');
      setMessages([]); await list();
    } catch (e) { setError((e as Error).message); }
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b p-3">
      <strong>TINA Agent</strong>
      <select aria-label="Cuộc trò chuyện" value={sessions.some(s => s.session === session) ? session : ''} disabled={busy} onChange={e => void select(e.target.value)} className="max-w-56 rounded border bg-background p-1 text-sm">
        <option value="" disabled>Cuộc trò chuyện mới</option>{sessions.map(s => <option key={s.session} value={s.session}>{s.title || s.session}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { generation.current++; const id = `dashboard-${crypto.randomUUID()}`; setSession(id); rememberSession(id); setMessages([]); setError(''); }}>Mới</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reset()}>Đặt lại</Button>
    </div>
    <div ref={scroller} className="flex-1 overflow-auto p-4 space-y-4">
      {!messages.length && <p className="text-sm text-muted-foreground">Hỏi về tài liệu hoặc nhờ agent cập nhật workspace. Để trả lời từ transcript có nguồn, mở Ask AI trong cuộc họp.</p>}
      {messages.map((m, i) => <article key={i} className={`rounded-lg p-3 text-sm ${m.role === 'user' ? 'bg-primary/10' : 'bg-muted'}`}><strong>{m.role === 'user' ? 'Bạn' : 'TINA'}</strong><div className="prose prose-sm dark:prose-invert max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{m.text || (busy ? 'Đang xử lý…' : '')}</ReactMarkdown></div></article>)}
    </div>
    {error && <p role="alert" className="px-4 text-sm text-destructive">{error}</p>}
    <form className="flex flex-col gap-2 border-t p-3" onSubmit={e => { e.preventDefault(); void send(); }}>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={research} disabled={busy} onChange={e => setResearch(e.target.checked)} />Nghiên cứu &amp; lưu ghi chú</label>
      <div className="flex gap-2"><Input aria-label="Tin nhắn cho agent" value={input} onChange={e => setInput(e.target.value)} placeholder="Nhập tin nhắn…" disabled={busy} />
        {busy ? <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>Dừng xem</Button> : <Button disabled={!input.trim()}>Gửi</Button>}
      </div>
    </form>
  </div>;
}
