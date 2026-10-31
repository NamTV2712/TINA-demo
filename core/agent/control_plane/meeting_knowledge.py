"""Owner-scoped meeting questions and explicitly reviewed, create-only Wiki pages."""
import json
import os
import re
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from shared.meeting_knowledge import digest, select_sources, sources_for, stale, validate_answer, wiki_page
from shared.adapters import WorkspaceBusyError, workspace_write_lock


class Question(BaseModel):
    model_config = {'extra': 'forbid'}
    question: str = Field(min_length=1, max_length=2000)
    documents: list[str] = Field(default_factory=list, max_length=8)


class FactReview(BaseModel):
    model_config = {'extra': 'forbid'}
    fact_id: str = Field(pattern=r'^[0-9a-f-]{36}$')
    expected_fingerprint: str = Field(pattern=r'^[0-9a-f]{64}$')
    expected_revision: int = Field(ge=0)
    status: str = Field(pattern=r'^(approved|discarded|pending)$')
    text: str = Field(min_length=1, max_length=4000)


def meeting_get(base, subject, meeting_id, suffix):
    if not base:
        raise HTTPException(503, 'Meeting service is not configured')
    req = urllib.request.Request(base.rstrip('/') + suffix, headers={'X-User-Id': subject})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            data = response.read(4_000_001)
            if len(data) > 4_000_000:
                raise HTTPException(413, 'Meeting is too large')
            return json.loads(data)
    except urllib.error.HTTPError as exc:
        raise HTTPException(404 if exc.code in (403, 404) else 503, 'Meeting unavailable') from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(503, 'Could not read meeting sources; retry shortly') from exc


def safe_dir(reader, base, relative):
    target = reader._workspace_child(base, relative)
    if target is None or any(p.is_symlink() for p in [base / relative, *(base / relative).parents] if p != base and base in p.parents):
        raise HTTPException(409, 'Invalid knowledge storage directory')
    target.mkdir(parents=True, exist_ok=True)
    return target


def register(app, subject_of, read_target, reader, meeting_api_url, complete):
    def facts(request, meeting_id, base):
        memory = meeting_get(meeting_api_url, subject_of(request), meeting_id,
                             f'/transcripts/by-id/{meeting_id}/memory')
        current = {fact['id']: fact for fact in memory.get('facts', [])}
        folder = reader._workspace_child(base, f'.meeting-knowledge/{meeting_id}/reviews')
        reviewed = {}
        if folder and folder.is_dir() and not folder.is_symlink():
            for path in folder.glob('*.json'):
                if not path.is_symlink() and re.fullmatch(r'[0-9a-f-]{36}', path.stem):
                    reviewed[path.stem] = json.loads(path.read_text())
        items = []
        for fact_id in dict.fromkeys([*current, *reviewed]):
            review = reviewed.get(fact_id)
            fact = current.get(fact_id) or review['fact']
            fingerprint = digest(fact)
            items.append({'fact': fact, 'fingerprint': fingerprint, 'review': review,
                          'stale': fact_id not in current or bool(review and review['fingerprint'] != fingerprint)})
        return items

    def load(request, meeting_id, slug=None):
        subject = subject_of(request)
        row = meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
        canonical = meeting_get(meeting_api_url, subject, meeting_id, f'/transcripts/by-id/{meeting_id}/canonical')
        base = read_target(request, slug)
        native = str(row.get('native_meeting_id') or row.get('platform_specific_id') or '')
        paths = set()
        for doc in (row.get('data') or {}).get('docs', []):
            if (isinstance(doc, dict) and isinstance(doc.get('path'), str)
                    and not doc.get('slug') and doc.get('workspace') in (None, '', subject, base.name)):
                paths.add(doc['path'])
        if re.fullmatch(r'[\w.-]{1,200}', native):
            paths.add(f'kg/entities/meeting/{native}.md')
        documents = {}
        for path in sorted(paths):
            if len(documents) >= 8:
                break
            if not path.endswith('.md') or not path.startswith(('kg/', 'wiki/')):
                continue
            try:
                text = reader.read_at(base, path)
                if text is not None and len(text) <= 50000:
                    documents[path] = text
            except (OSError, ValueError):
                raise HTTPException(503, 'Could not read related documents')
        # Only resolve links from the meeting's own documents; do not search unrelated workspaces.
        links = {m.group(1).strip() for text in documents.values() for m in re.finditer(r'\[\[([^\]]+)\]\]', text)}
        slugs = {re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') for name in links}
        if slugs and len(documents) < 8:
            for path in reader.tree_at(base):
                if path.startswith('kg/entities/') and Path(path).stem in slugs and len(documents) < 8:
                    text = reader.read_at(base, path)
                    if text is not None and len(text) <= 50000:
                        documents[path] = text
        return base, canonical, documents

    def stored(reader_base, meeting_id, answer_id):
        if not re.fullmatch(r'[0-9a-f]{32}', answer_id):
            raise HTTPException(404, 'Answer not found')
        path = reader._workspace_child(reader_base, f'.meeting-knowledge/{meeting_id}/{answer_id}.json')
        if path is None or not path.is_file() or path.is_symlink():
            raise HTTPException(404, 'Answer not found')
        return json.loads(path.read_text())

    def page_path(meeting_id, answer_id):
        return f'wiki/meetings/{meeting_id}/{answer_id}.md'

    def view(base, meeting_id, answer, current):
        page = reader._workspace_child(base, page_path(meeting_id, answer['id']))
        return answer | {'stale': stale(answer, current),
                         'saved_path': page_path(meeting_id, answer['id']) if page and page.is_file() else None}

    @app.get('/api/workspace/meeting-knowledge/{meeting_id}')
    def knowledge(request: Request, meeting_id: int):
        base, canonical, documents = load(request, meeting_id)
        folder = reader._workspace_child(base, f'.meeting-knowledge/{meeting_id}')
        answers = []
        if folder and folder.is_dir() and not folder.is_symlink():
            for path in sorted(folder.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
                if path.is_symlink() or not re.fullmatch(r'[0-9a-f]{32}', path.stem):
                    continue
                answer = stored(base, meeting_id, path.stem)
                answers.append(view(base, meeting_id, answer, sources_for(canonical, documents)))
        return {'documents': [{'path': path, 'title': Path(path).stem} for path in documents],
                'answers': answers, 'segment_count': len(canonical.get('segments', [])),
                'facts': facts(request, meeting_id, base)}

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/facts/review')
    def review_fact(request: Request, meeting_id: int, body: FactReview):
        base, canonical, _ = load(request, meeting_id)
        if not body.text.strip():
            raise HTTPException(422, 'Review text is empty')
        try:
            with workspace_write_lock(base):
                item = next((item for item in facts(request, meeting_id, base)
                             if item['fact']['id'] == body.fact_id), None)
                if not item or item['stale'] or item['fingerprint'] != body.expected_fingerprint:
                    raise HTTPException(409, 'Evidence changed. Reload before reviewing.')
                previous = item['review']
                revision = previous['revision'] if previous else 0
                if revision != body.expected_revision:
                    raise HTTPException(409, 'This review changed elsewhere. Your draft was kept.')
                by_id = {s['segment_id']: s for s in canonical.get('segments', [])}
                for evidence in item['fact'].get('evidence', []):
                    segment = by_id.get(evidence.get('segment_id'))
                    if (not segment or segment['text'] != evidence['quote']
                            or any(segment.get(k) != evidence.get(k) for k in ('revision', 'speaker_name', 'start_ms', 'end_ms'))):
                        raise HTTPException(409, 'Evidence changed. Reload before reviewing.')
                result = {'fact': item['fact'], 'fingerprint': item['fingerprint'],
                          'status': body.status, 'text': body.text.strip(), 'revision': revision + 1,
                          'reviewed_at': datetime.now(timezone.utc).isoformat()}
                directory = safe_dir(reader, base, f'.meeting-knowledge/{meeting_id}/reviews')
                with tempfile.NamedTemporaryFile(dir=directory, mode='w', delete=False) as out:
                    temporary = Path(out.name)
                    json.dump(result, out, ensure_ascii=False)
                try:
                    os.replace(temporary, directory / f'{body.fact_id}.json')
                finally:
                    temporary.unlink(missing_ok=True)
                return result
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Retry shortly.') from exc

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/ask')
    def ask(request: Request, meeting_id: int, body: Question):
        if not body.question.strip():
            raise HTTPException(422, 'Enter a question')
        base, canonical, documents = load(request, meeting_id)
        if any(path not in documents for path in body.documents):
            raise HTTPException(422, 'Choose documents linked to this meeting')
        candidates = sources_for(canonical, {path: documents[path] for path in body.documents})
        selected = select_sources(candidates, body.question)
        if not selected:
            raise HTTPException(409, 'No confirmed transcript or selected documents yet')
        raw = complete(request, json.dumps({'question': body.question, 'sources': selected}, ensure_ascii=False))
        try:
            answer = validate_answer(raw, selected)
        except (ValueError, TypeError) as exc:
            raise HTTPException(502, 'The answer had invalid sources. Please retry.') from exc
        answer.update(id=uuid.uuid4().hex, question=body.question.strip(),
                      created_at=datetime.now(timezone.utc).isoformat(),
                      coverage={'selected': len(selected), 'available': len(candidates),
                                'bounded': len(selected) < len(candidates) or any(len(s['quote']) > 2400 for s in candidates)})
        # Re-read after inference: a delayed answer may already refer to an edited transcript.
        latest_base, latest, docs = load(request, meeting_id)
        if latest_base != base:
            raise HTTPException(409, 'Workspace changed. Ask again in the current workspace.')
        directory = safe_dir(reader, base, f'.meeting-knowledge/{meeting_id}')
        target = directory / f'{answer["id"]}.json'
        with tempfile.NamedTemporaryFile(dir=directory, mode='w', delete=False) as out:
            temporary = Path(out.name)
            json.dump(answer, out, ensure_ascii=False)
        try:
            os.link(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return view(base, meeting_id, answer, sources_for(latest, docs))

    @app.get('/api/workspace/meeting-knowledge/{meeting_id}/answers/{answer_id}')
    def answer_state(request: Request, meeting_id: int, answer_id: str, slug: str | None = None):
        base, canonical, documents = load(request, meeting_id, slug)
        answer = stored(base, meeting_id, answer_id)
        return view(base, meeting_id, answer, sources_for(canonical, documents))

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/answers/{answer_id}/apply')
    def apply(request: Request, meeting_id: int, answer_id: str):
        base, canonical, documents = load(request, meeting_id)
        answer = stored(base, meeting_id, answer_id)
        if not answer['claims'] or stale(answer, sources_for(canonical, documents)):
            raise HTTPException(409, 'Sources changed or evidence is missing. Ask again before saving.')
        directory = safe_dir(reader, base, f'wiki/meetings/{meeting_id}')
        target = directory / f'{answer_id}.md'
        content = wiki_page(answer, meeting_id)
        # Exclusive publication keeps retries idempotent and never overwrites an edited Wiki page.
        with tempfile.NamedTemporaryFile(dir=directory, mode='w', delete=False) as out:
            temporary = Path(out.name)
            out.write(content)
        try:
            try:
                os.link(temporary, target)
            except FileExistsError:
                if target.is_symlink() or target.read_text() != content:
                    raise HTTPException(409, 'This Wiki page was edited. Existing content was kept.')
        finally:
            temporary.unlink(missing_ok=True)
        return {'path': page_path(meeting_id, answer_id)}
