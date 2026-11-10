"use client";
import { useEffect, useRef, useState } from 'react';
import styles from './workspacePanel.module.css';

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
      setStatus(`${Math.min(all.length, 50)} kết quả${all.length > 50 || results.some(result => result.bounded) ? '. Đã chạm giới hạn tìm kiếm.' : ''}`);
    } catch (error) { if (ticket === serial.current) setStatus((error as Error).message); }
  }
  return <details className={styles.contentSearch}><summary>Tìm trong nội dung</summary>
    <form className={styles.searchForm} onSubmit={event => { event.preventDefault(); void search(); }}>
      <input type="search" aria-label="Nội dung cần tìm" placeholder="Từ hoặc cụm cần tìm" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} />
      <button type="submit" className={styles.searchButton} disabled={!query.trim() || !mounts.length}>Tìm</button>
    </form>
    <p className={styles.searchStatus} role="status">{status}</p>
    {hits.length > 0 && <div className={styles.searchResults}>
      {hits.map(hit => <button className={styles.searchResult} type="button" key={`${hit.slug}:${hit.path}:${hit.line}`}
        aria-label={`${hit.workspace}, ${hit.path}, line ${hit.line}: ${hit.text}`} onClick={() => onOpen(hit.path, hit.slug)}>
        <span className={styles.resultMeta}>
          <span>{hit.workspace}</span>
          <span className={styles.resultPath}>{hit.path}</span>
          <span>Line {hit.line}</span>
        </span>
        <span className={styles.resultExcerpt}>{hit.text}</span>
      </button>)}
    </div>}
  </details>;
}
