"use client";
import { useEffect, useRef, useState } from 'react';

export function WorkspaceContentSearch({ mounts, onOpen }: {
  mounts: Array<{ slug: string; name?: string | null }>; onOpen: (path: string, slug: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ path: string; line: number; text: string; slug: string; workspace: string }>>([]);
  const [status, setStatus] = useState('');
  const serial = useRef(0);
  const scope = mounts.map(m => m.slug).join('\0');
  useEffect(() => { serial.current++; setHits([]); setStatus(''); return () => { serial.current++; }; }, [scope]);
  async function search() {
    const ticket = ++serial.current;
    setHits([]); setStatus('Đang tìm trong nội dung…');
    try {
      const results = await Promise.all(mounts.map(async mount => {
        const response = await fetch(`/api/workspace/search?${new URLSearchParams({ q: query.trim(), slug: mount.slug })}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Không đọc được nội dung workspace ${mount.name || mount.slug}.`);
        const result: { hits: Array<{ path: string; line: number; text: string }>; bounded: boolean } = await response.json();
        return { ...result, hits: result.hits.map(hit => ({ ...hit, slug: mount.slug, workspace: mount.name || mount.slug })) };
      }));
      if (ticket !== serial.current) return;
      const all = results.flatMap(result => result.hits);
      setHits(all.slice(0, 50));
      setStatus(`${Math.min(all.length, 50)} kết quả${all.length > 50 || results.some(result => result.bounded) ? ' · đã chạm giới hạn tìm kiếm' : ''}`);
    } catch (error) { if (ticket === serial.current) setStatus((error as Error).message); }
  }
  return <details style={{ margin: '4px 8px 10px', fontSize: 12 }}><summary>Tìm trong nội dung Knowledge</summary>
    <form onSubmit={event => { event.preventDefault(); void search(); }}>
      <input aria-label="Nội dung cần tìm" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} />
      <button type="submit" disabled={!query.trim() || !mounts.length}>Tìm nội dung</button>
    </form>
    <p role="status">{status}</p>
    {hits.map(hit => <button type="button" key={`${hit.slug}:${hit.path}:${hit.line}`} onClick={() => onOpen(hit.path, hit.slug)} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8 }}>
      <strong>{hit.workspace} · {hit.path}:{hit.line}</strong><br />{hit.text}
    </button>)}
  </details>;
}
