"use client";
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MeetingKnowledge } from '@/components/meetings/meeting-knowledge';
import { useAuthStore } from '@/stores/auth-store';
import { withBasePath } from '@/lib/base-path';
import type { Meeting, TranscriptSegment } from '@/types/tina';

export function AIChatPanel({ meeting, trigger }: { meeting?: Meeting; transcripts?: TranscriptSegment[]; trigger?: ReactNode }) {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('answer'));
  const [model, setModel] = useState('Đang đọc cấu hình…');
  const owner = useAuthStore(s => String(s.user?.id || ''));
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(withBasePath('/api/ai/config'), { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error();
      const config = await r.json();
      if (alive) setModel(config.chatgpt_connected === false ? 'Kết nối ChatGPT trong Terminal → Settings → Models' : `${config.model || 'Model mặc định'} · dùng chung với Terminal`);
    }).catch(() => { if (alive) setModel('Chưa đọc được cấu hình model. Hãy đăng nhập và thử lại.'); });
    return () => { alive = false; };
  }, [open, owner]);
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild>{trigger || <Button>Ask AI</Button>}</DialogTrigger>
    <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>Hỏi về cuộc họp và lưu vào Wiki</DialogTitle><DialogDescription>{model}</DialogDescription></DialogHeader>
      {meeting ? <MeetingKnowledge key={`${owner}/${meeting.id}`} meetingId={String(meeting.id)} /> : <p>Mở một cuộc họp để hỏi từ transcript của nó.</p>}
    </DialogContent>
  </Dialog>;
}
