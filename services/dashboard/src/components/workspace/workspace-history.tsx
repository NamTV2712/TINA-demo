"use client";
import { useEffect, useRef, useState } from 'react';
import { withBasePath } from '@/lib/base-path';

export function WorkspaceHistory({ slug, path, revision }: { slug: string; path: string; revision: number }) {
  const [commits, setCommits] = useState<Array<{ sha: string; msg: string; author?: string }>>([]);
  const [changes, setChanges] = useState<Array<{ path: string; kind: string }>>([]);
  const [diff, setDiff] = useState('');
  const [error, setError] = useState('');
  const serial = useRef(0);
  useEffect(() => {
    serial.current++;
    const abort = new AbortController();
    setDiff(''); setError('');
    void fetch(withBasePath(`/api/agent/workspace/git?slug=${encodeURIComponent(slug)}`), { cache: 'no-store', signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Không đọc được lịch sử workspace.');
        const value = await response.json();
        if (!abort.signal.aborted) { setCommits(value.commits || []); setChanges(value.changes || []); }
      }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => { abort.abort(); serial.current++; };
  }, [slug, path, revision]);
  async function inspect(sha: string) {
    const ticket = ++serial.current;
    try {
      const response = await fetch(withBasePath(`/api/agent/workspace/git/show?${new URLSearchParams({ slug, sha, ...(path ? { path } : {}) })}`), { cache: 'no-store' });
      if (!response.ok) throw new Error('Không đọc được thay đổi của phiên bản này.');
      const value = await response.json();
      if (ticket === serial.current) setDiff(value.diff || 'Phiên bản này không thay đổi tài liệu đang mở.');
    } catch (error) { if (ticket === serial.current) setError((error as Error).message); }
  }
  return <details className="my-3 rounded border p-2"><summary>Lịch sử workspace · {changes.length} file chưa ghi phiên bản</summary>
    {error && <p role="alert">{error}</p>}
    {changes.map(change => <p key={change.path} className="text-xs">{change.kind} · {change.path}</p>)}
    {commits.map(commit => <button key={commit.sha} type="button" className="block text-left text-xs underline" onClick={() => void inspect(commit.sha)}>{commit.sha} · {commit.msg} · {commit.author}</button>)}
    {diff && <pre className="max-h-64 overflow-auto whitespace-pre text-xs">{diff}</pre>}
  </details>;
}
