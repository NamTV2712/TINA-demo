"""Owner-scoped meeting questions and explicitly reviewed, create-only Wiki pages."""
import json
import os
import re
import tempfile
import urllib.error
import urllib.request
import uuid
import yaml
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field, PositiveInt

from shared.meeting_knowledge import digest, select_sources, sources_for, stale, validate_answer, wiki_page
from shared.adapters import WorkspaceBusyError, parse_entity, workspace_write_lock
from shared.document_links import wikilink_paths


class Question(BaseModel):
    model_config = {'extra': 'forbid'}
    question: str = Field(min_length=1, max_length=2000)
    documents: list[str] = Field(default_factory=list, max_length=8)
    meeting_ids: list[PositiveInt] = Field(default_factory=list, max_length=4)


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
    def content_path(base, path):
        parts = Path(path).parts
        if (not parts or Path(path).is_absolute() or Path(path).suffix != '.md'
                or any(part.startswith('.') for part in parts)
                or not (path == 'README.md' or parts[0] in {'kg', 'wiki', 'notes', 'docs', 'sources', 'concepts'})):
            return None
        raw = base / path
        if any(p.is_symlink() for p in [raw, *raw.parents] if base in p.parents):
            return None
        return reader._workspace_child(base, path)

    def document_paths(request, base):
        if not hasattr(request.state, 'knowledge_paths'):
            request.state.knowledge_paths = {}
        cache = request.state.knowledge_paths
        if base not in cache:
            paths = []
            def unreadable(error):
                raise error
            try:
                for directory, folders, files in os.walk(base, onerror=unreadable):
                    folders[:] = sorted(name for name in folders if not name.startswith('.') and not (Path(directory) / name).is_symlink())
                    for name in sorted(files):
                        path = (Path(directory) / name).relative_to(base).as_posix()
                        if content_path(base, path) is not None:
                            paths.append(path)
                            if len(paths) > 1000:
                                raise HTTPException(413, 'Workspace has too many Markdown documents to locate meeting sources safely')
            except OSError as exc:
                raise HTTPException(503, 'Could not read workspace documents; retry shortly') from exc
            cache[base] = paths
        return cache[base]

    def related_text(base, path):
        target = content_path(base, path)
        if target is None or not target.is_file():
            return None
        try:
            with target.open('rb') as stream:
                raw = stream.read(200001)
            if len(raw) > 200000:
                return None
            text = raw.decode('utf-8')
            return text if len(text) <= 50000 else None
        except (OSError, ValueError) as exc:
            raise HTTPException(503, 'Could not read related documents') from exc

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
            text = related_text(base, path)
            if text is not None:
                documents[path] = text
        # Only resolve links from the meeting's own documents; do not search unrelated workspaces.
        links = [(path, match.group(1)) for path, text in documents.items()
                 for match in re.finditer(r'\[\[([^\]]+)\]\]', text)]
        if links and len(documents) < 8:
            visible = document_paths(request, base)
            for origin, link in links:
                if len(documents) >= 8:
                    break
                matches = wikilink_paths(link, origin, visible)
                if len(matches) != 1:
                    continue
                path = matches[0]
                text = related_text(base, path)
                if text is not None:
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

    def saved_page(request, base, meeting_id, answer_id):
        original = page_path(meeting_id, answer_id)
        target = content_path(base, original)
        if target is not None and target.is_file():
            return original
        if not hasattr(request.state, 'knowledge_pages'):
            request.state.knowledge_pages = {}
        cache = request.state.knowledge_pages
        key = (base, meeting_id)
        if key not in cache:
            pages, size = {}, 0
            for path in document_paths(request, base):
                target = content_path(base, path)
                if target is None or not target.is_file():
                    continue
                try:
                    with target.open('rb') as stream:
                        raw = stream.read(500001)
                    size += len(raw)
                    if len(raw) > 500000 or size > 10_000_000:
                        raise HTTPException(413, 'Markdown content exceeds the saved Wiki page discovery limit')
                    metadata, _ = parse_entity(raw.decode('utf-8').replace('\r\n', '\n'))
                except OSError as exc:
                    raise HTTPException(503, 'Could not locate saved Wiki pages; retry shortly') from exc
                except (UnicodeDecodeError, yaml.YAMLError):
                    # Unrelated malformed YAML must not make ordinary document browsing fail.
                    continue
                if not isinstance(metadata, dict) or str(metadata.get('meeting_id')) != str(meeting_id):
                    continue
                identifier = metadata.get('meeting_answer_id')
                if isinstance(identifier, str) and re.fullmatch(r'[0-9a-f]{32}', identifier):
                    pages.setdefault(identifier, []).append(path)
            cache[key] = pages
        matches = cache[key].get(answer_id, [])
        if len(matches) > 1:
            raise HTTPException(409, 'Multiple Wiki pages refer to this answer. Review the copies before saving again.')
        return matches[0] if matches else None

    def scoped_sources(request, meeting_id, current, additional):
        result = [s | {'meeting_id': meeting_id} for s in current]
        if not hasattr(request.state, 'knowledge_sources'):
            request.state.knowledge_sources = {}
        cache = request.state.knowledge_sources
        for mid in dict.fromkeys(additional):
            if mid == meeting_id:
                continue
            if mid in cache:
                result.extend(cache[mid])
                continue
            subject = subject_of(request)
            row = meeting_get(meeting_api_url, subject, mid, f'/meetings/{mid}')
            canonical = meeting_get(meeting_api_url, subject, mid, f'/transcripts/by-id/{mid}/canonical')
            cache[mid] = [s | {'key': f'meeting:{mid}:' + s['key'], 'meeting_id': mid,
                              'meeting_title': row.get('title') or f'Cuộc họp {mid}'}
                          for s in sources_for(canonical, {})]
            result.extend(cache[mid])
        return result

    def view(request, base, meeting_id, answer, current):
        try:
            current = scoped_sources(request, meeting_id, current, answer.get('meeting_ids', []))
        except HTTPException as exc:
            if exc.status_code not in (403, 404):
                raise
            # A removed/revoked meeting cannot expose old quotes or block the remaining history.
            return answer | {'claims': [], 'sources': [], 'stale': True, 'saved_path': None}
        return answer | {'stale': stale(answer, current),
                         'saved_path': saved_page(request, base, meeting_id, answer['id'])}

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
                answers.append(view(request, base, meeting_id, answer, sources_for(canonical, documents)))
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
        additional = list(dict.fromkeys(mid for mid in body.meeting_ids if mid != meeting_id))
        candidates = scoped_sources(request, meeting_id,
                                    sources_for(canonical, {path: documents[path] for path in body.documents}), additional)
        selected = select_sources(candidates, body.question)
        if not selected:
            raise HTTPException(409, 'No confirmed transcript or selected documents yet')
        raw = complete(request, json.dumps({'question': body.question, 'sources': selected}, ensure_ascii=False))
        try:
            answer = validate_answer(raw, selected)
        except (ValueError, TypeError) as exc:
            raise HTTPException(502, 'The answer had invalid sources. Please retry.') from exc
        answer.update(id=uuid.uuid4().hex, question=body.question.strip(),
                      meeting_ids=additional,
                      created_at=datetime.now(timezone.utc).isoformat(),
                      coverage={'selected': len(selected), 'available': len(candidates),
                                'bounded': len(selected) < len(candidates) or any(len(s['quote']) > 2400 for s in candidates)})
        # Re-read after inference: a delayed answer may already refer to an edited transcript.
        latest_base, latest, docs = load(request, meeting_id)
        request.state.knowledge_sources = {}
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
        return view(request, base, meeting_id, answer, sources_for(latest, docs))

    @app.get('/api/workspace/meeting-knowledge/{meeting_id}/answers/{answer_id}')
    def answer_state(request: Request, meeting_id: int, answer_id: str, slug: str | None = None):
        base, canonical, documents = load(request, meeting_id, slug)
        answer = stored(base, meeting_id, answer_id)
        return view(request, base, meeting_id, answer, sources_for(canonical, documents))

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/answers/{answer_id}/apply')
    def apply(request: Request, meeting_id: int, answer_id: str):
        base, canonical, documents = load(request, meeting_id)
        answer = stored(base, meeting_id, answer_id)
        current = scoped_sources(request, meeting_id, sources_for(canonical, documents), answer.get('meeting_ids', []))
        if not answer['claims'] or stale(answer, current):
            raise HTTPException(409, 'Sources changed or evidence is missing. Ask again before saving.')
        content = wiki_page(answer, meeting_id)
        try:
            with workspace_write_lock(base):
                request.state.knowledge_paths = {}
                request.state.knowledge_pages = {}
                existing = saved_page(request, base, meeting_id, answer_id)
                if existing:
                    target = content_path(base, existing)
                    if target is None or target.read_text() != content:
                        raise HTTPException(409, 'This Wiki page was edited. Existing content was kept.')
                    return {'path': existing}
                directory = safe_dir(reader, base, f'wiki/meetings/{meeting_id}')
                target = directory / f'{answer_id}.md'
                # Exclusive publication never overwrites an existing page, including external writes.
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
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Retry shortly.') from exc
