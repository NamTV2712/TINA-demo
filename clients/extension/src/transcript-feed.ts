import { groupSegments, type TranscriptSegment } from './transcript-rendering';
import { translationSegments, type TranscriptLanguage, type TranslationGroup, type PhraseTranslation } from './translation';

type Segment = TranscriptSegment & { speaker_key?: string; translation?: PhraseTranslation };
const identity = (s: Segment): string => s.segment_id || `${s.speaker_key || s.speaker || ''}:${s.absolute_start_time}`;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; return el;
}
function text(el: HTMLElement, value: string): void { if (el.textContent !== value) el.textContent = value; }
function reconcile(parent: HTMLElement, children: HTMLElement[]): void {
  children.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null); });
  while (parent.children.length > children.length) parent.lastElementChild!.remove();
}

/** Update only changed text; keep the reader's scroll anchor through live revisions. */
export function createTranscriptFeed(feed: HTMLElement, root: HTMLElement, latest: HTMLButtonElement) {
  const rows = new Map<string, ReturnType<typeof createTurn>>();
  const spans = new Map<string, HTMLSpanElement>();
  const translations = new Map<string, HTMLSpanElement>();
  const originals = new Map<string, HTMLSpanElement>();
  let following = true;
  function createTurn() {
    const row = element('article', 'transcript-turn'); row.setAttribute('role', 'listitem');
    const header = element('header', 'turn-header');
    const avatar = element('span', 'speaker-avatar'); avatar.setAttribute('aria-hidden', 'true');
    const name = element('strong', 'speaker-name'), time = element('time', 'turn-time');
    const confirmed = element('p', 'turn-copy'), draft = element('div', 'turn-draft');
    const label = element('span', 'draft-label'), pending = element('p', 'turn-copy');
    header.append(avatar, name, time); draft.append(label, pending); row.append(header, confirmed, draft);
    return { row, avatar, name, time, confirmed, draft, label, pending };
  }
  function updateLatest() { latest.hidden = following || !root.children.length; }
  function scrollToLatest() { following = true; latest.hidden = true; feed.scrollTop = feed.scrollHeight; }
  feed.addEventListener('scroll', () => {
    if (!feed.clientHeight) return;
    following = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 48; updateLatest();
  }, { passive: true });
  latest.addEventListener('click', scrollToLatest);
  return {
    reset() { rows.clear(); spans.clear(); translations.clear(); originals.clear(); root.replaceChildren(); following = true; latest.hidden = true; feed.scrollTop = 0; },
    reveal() { if (following) scrollToLatest(); },
    render(segments: Segment[], draftLabel: string, language: TranscriptLanguage = 'vi', translationGroups: TranslationGroup[] = [], paused = false) {
      const selection = document.getSelection?.();
      const selected = selection?.rangeCount && feed.contains(selection.anchorNode) && feed.contains(selection.focusNode)
        ? { anchor: selection.anchorNode!, anchorOffset: selection.anchorOffset, focus: selection.focusNode!, focusOffset: selection.focusOffset } : null;
      const oldTop = feed.scrollTop;
      const anchor = !following && feed.clientHeight ? Array.from(root.children).find(row => row.getBoundingClientRect().bottom > feed.getBoundingClientRect().top) : undefined;
      const anchorTop = anchor?.getBoundingClientRect().top;
      const displayed = language === 'vi' ? segments : translationSegments(segments, translationGroups);
      const groups = groupSegments(displayed, { getGroupKey: s => (s as Segment).speaker_key || s.speaker || 'unknown' });
      const activeRows = new Set<string>(), activeSpans = new Set<string>();
      const ordered = groups.map(group => {
        const key = identity(group.segments[0]); activeRows.add(key);
        let turn = rows.get(key); if (!turn) { turn = createTurn(); rows.set(key, turn); }
        const name = group.segments[0].speaker || 'Unknown speaker';
        text(turn.name, name); text(turn.avatar, group.segments[0].speaker ? Array.from(name)[0].toUpperCase() : '?');
        const date = new Date(group.startTime);
        text(turn.time, Number.isFinite(date.getTime()) ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
        if (turn.time.dateTime !== group.startTime) turn.time.dateTime = group.startTime;
        const confirmed: HTMLElement[] = [], pending: HTMLElement[] = [];
        for (const segment of group.segments) {
          const id = identity(segment); activeSpans.add(id);
          let span = spans.get(id); if (!span) { span = element('span', 'transcript-segment'); spans.set(id, span); }
          if (language === 'vi') {
            text(span, segment.text.trim() + ' ');
            originals.delete(id); translations.delete(id);
            span.classList.remove('segment-bilingual');
          } else {
            let original = originals.get(id), english = translations.get(id);
            if (!original || !english) {
              original = element('span', 'segment-original'); english = element('span', 'segment-english'); english.lang = 'en';
              originals.set(id, original); translations.set(id, english); span.replaceChildren(original, english);
            }
            span.classList.add('segment-bilingual');
            const result = segment.translation?.text;
            text(original, segment.text.trim()); original.hidden = language === 'en' && !!result;
            text(english, `EN  ${result || (segment.completed === false ? 'Chờ đoạn nói hoàn tất…' : paused ? 'Chưa dịch được · bản gốc vẫn được giữ' : segment.translation?.ready ? 'Đang dịch…' : 'Đang gom câu…')}`);
          }
          (segment.completed === false ? pending : confirmed).push(span);
        }
        reconcile(turn.confirmed, confirmed); reconcile(turn.pending, pending);
        turn.confirmed.hidden = !confirmed.length; turn.draft.hidden = !pending.length;
        text(turn.label, draftLabel);
        return turn.row;
      });
      reconcile(root, ordered);
      for (const key of rows.keys()) if (!activeRows.has(key)) rows.delete(key);
      for (const key of spans.keys()) if (!activeSpans.has(key)) { spans.delete(key); originals.delete(key); translations.delete(key); }
      updateLatest();
      const anchoredTop = anchor?.isConnected && anchorTop !== undefined ? oldTop + anchor.getBoundingClientRect().top - anchorTop : oldTop;
      // Moving an unchanged span between paragraph groups clears Chrome's selection.
      if (selected?.anchor.isConnected && selected.focus.isConnected && selection &&
          (selection.anchorNode !== selected.anchor || selection.anchorOffset !== selected.anchorOffset || selection.focusNode !== selected.focus || selection.focusOffset !== selected.focusOffset)) {
        const offset = (node: Node, value: number) => Math.min(value, node.nodeType === 3 ? node.textContent?.length ?? 0 : node.childNodes.length);
        selection.setBaseAndExtent(selected.anchor, offset(selected.anchor, selected.anchorOffset), selected.focus, offset(selected.focus, selected.focusOffset));
      }
      if (feed.clientHeight) {
        if (following) feed.scrollTop = feed.scrollHeight;
        else feed.scrollTop = anchoredTop;
      }
    },
  };
}
