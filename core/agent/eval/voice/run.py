"""Synthetic voice regression through the real control-plane and worker, without live meeting data."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import time
import unicodedata

from fastapi import FastAPI
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge as api
from control_plane.workspace_reader import WorkspaceReader
from shared.meeting_knowledge import PREFIX, sources_for
from shared import voice_knowledge as voice
from shared.voice_knowledge import voice_route
from worker.engine import _run_meeting_knowledge
from shared.voice_trace import voice_trace_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Call the configured LLM using only synthetic fixtures')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cases', help='Comma-separated case IDs; default: all')
    parser.add_argument('--prompt-file', type=Path, help='Override only voice wording for a controlled comparison')
    parser.add_argument('--label', default='current')
    args = parser.parse_args()
    if args.prompt_file:
        baseline = args.prompt_file.read_text()
        voice.VOICE_REPAIR_SYSTEM = baseline + voice.VOICE_REPAIR_SYSTEM[len(voice.VOICE_SYSTEM):]
        voice.VOICE_SYSTEM = baseline
    fixture = json.loads(Path(__file__).with_name('questions.json').read_text())
    if args.cases:
        ids = {int(value) for value in args.cases.split(',')}
        if ids - {c['id'] for c in fixture['cases']}: parser.error('Unknown case ID')
        fixture['cases'] = [c for c in fixture['cases'] if c['id'] in ids]
    results = []
    now = int(time.time() * 1000)
    with tempfile.TemporaryDirectory(prefix='tina-voice-eval-') as directory:
        root = Path(directory) / '7'; root.mkdir()
        for name, content in fixture['documents'].items():
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content)
        canonical = {'segments': [s | {'revision': 0, 'start_ms': now+s['offset_ms']-500,
                                      'end_ms': now+s['offset_ms']} for s in fixture['segments']]}
        current_sources = voice.voice_chunks(sources_for(canonical, fixture['documents']))
        row = {'id': 1, 'user_id': 7, 'status': 'active', 'platform': 'google_meet', 'native_meeting_id': 'synthetic',
               'data': {'docs': [{'path': p} for p in fixture['documents']], 'voice_assistant': {
                   'enabled': True, 'revision': 1, 'include_transcript': True, 'documents': list(fixture['documents']),
                   'allow_general_knowledge': True, 'allow_web_search': True}}}
        api.meeting_get = lambda base, subject, mid, path: canonical if path.endswith('/canonical') else row
        os.environ['TINA_INTERNAL_API_SECRET'] = 'synthetic-eval-only'
        os.environ['TINA_CHAT_SESSION'] = 'meeting-knowledge-synthetic-eval'
        class Stream:
            def __init__(self): self.text = []
            def xadd(self, topic, fields):
                event = json.loads(fields['event'])
                if event.get('type') == 'message-delta': self.text.append(event['text'])
            def expire(self, *args): pass
        def complete(request, text):
            stream = Stream()
            _run_meeting_knowledge(stream, 'synthetic-output', {'entrypoint': {'inline': PREFIX+json.dumps({
                'request_id': 'synthetic-eval', 'voice_trace_id': voice_trace_id.get(), 'text': text})}})
            return ''.join(stream.text)
        app = FastAPI()
        api.register(app, lambda r: '7', lambda r, slug: root, WorkspaceReader(directory), 'http://synthetic', complete)
        client = TestClient(app)
        normalize = lambda s: unicodedata.normalize('NFKC', s).casefold()
        for case in fixture['cases']:
            started = time.monotonic()
            result = {'id': case['id'], 'route_correct': voice_route(case['question'])[0] == case['mode']}
            if args.live:
                history = []
                for turn in case.get('history', []):
                    refs = [{'key': s['key'], 'fingerprint': s['fingerprint']} for s in current_sources
                            if s.get('segment_id') in turn['segment_ids']]
                    history.append({k: turn[k] for k in ('question', 'answer')} | {
                        'sources': refs, 'created_at_ms': now - 1000})
                response = client.post('/api/internal/meeting-voice/1/answer', headers={
                    'X-Internal-Secret': 'synthetic-eval-only', 'X-User-Id': '7'}, json={'question': case['question'], 'revision': 1, 'history': history})
                body = response.json()
                result.update(http_status=response.status_code, reason=body.get('reason'), text=body.get('text'),
                              lookups=body.get('lookups', []), links=body.get('links', []),
                              verification=body.get('verification', []),
                              source_count=len(body.get('sources', [])),
                              review_focus=case.get('review_focus', ''),
                              human_ratings={'naturalness_1_to_5': None, 'correctness_1_to_5': None})
                if case['expected_terms']:
                    result['expected_terms_present'] = all(normalize(t) in normalize(body.get('text', '')) for t in case['expected_terms'])
                    result['has_evidence'] = bool(body.get('sources'))
                elif case.get('expect_evidence') is False:
                    result['no_unsupported_answer'] = body.get('reason') != 'answered'
            result['elapsed_ms'] = round((time.monotonic() - started) * 1000)
            result['passed'] = result['route_correct'] and (not args.live or response.status_code == 200)
            if args.live and case['mode'] == 'meeting':
                result['passed'] = result['passed'] and (
                    result.get('expected_terms_present', True) and result.get('has_evidence', True)
                    and result.get('no_unsupported_answer', True))
            results.append(result)
            print(json.dumps({k: v for k, v in result.items() if k not in ('text', 'links')}, ensure_ascii=False), flush=True)
    report = {'label': args.label, 'kind': fixture['kind'], 'live_llm': args.live, 'cases': results,
              'note': 'Term checks are a smoke signal, not human-rated semantic correctness or a real Vietnamese meeting benchmark.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    if not all(r['passed'] for r in results): raise SystemExit(1)


if __name__ == '__main__': main()
