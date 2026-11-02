"""Explicit owner Markdown edits with content preconditions and path-only local commits."""
import hashlib
import os
import tempfile
import json
import difflib
from pathlib import Path

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

from shared.adapters import WorkspaceBusyError, parse_entity, workspace_write_lock
from shared.document_links import rewrite_links


def sha(content):
    return hashlib.sha256(content).hexdigest() if content is not None else None


class DocumentWrite(BaseModel):
    model_config = {'extra': 'forbid'}
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=500000)
    expected_sha256: str | None = Field(pattern=r'^[0-9a-f]{64}$', default=None)
    slug: str | None = None
    commit: bool = False
    commit_message: str = Field(default='Review Markdown document', min_length=1, max_length=200)


class DocumentChange(BaseModel):
    model_config = {'extra': 'forbid'}
    path: str = Field(min_length=1, max_length=500)
    expected_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    slug: str | None = None


class DocumentMove(DocumentChange):
    destination: str = Field(min_length=1, max_length=500, pattern=r'^[^\x00-\x1f\x7f]+$')
    update_links: bool = False
    expected_plan: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')


def editable(path):
    p = Path(path)
    return (not p.is_absolute() and p.suffix == '.md' and all(not part.startswith('.') for part in p.parts)
            and (path == 'README.md' or p.parts[0] in {'wiki', 'kg', 'notes', 'sources', 'concepts', 'docs'}))


def atomic_write(path, content, *, create=False):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        temporary = Path(out.name)
        out.write(content)
    try:
        if create:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_content(path, content):
    if path.startswith('kg/entities/') and Path(path).name not in ('index.md', 'log.md'):
        import contracts
        try:
            frontmatter, _ = parse_entity(content.decode('utf-8'))
            contracts.validate_entity_frontmatter(frontmatter)
        except Exception as exc:
            raise HTTPException(422, 'Invalid Wiki entity frontmatter; existing files were kept') from exc


def register(app, subject_of, read_target, private_write_target, reader):
    def target_for(base, path):
        raw = base / path
        target = reader._workspace_child(base, path)
        if not editable(path):
            raise HTTPException(403, 'Only content Markdown documents can be changed here')
        if target is None or any(p.is_symlink() for p in [raw, *raw.parents] if base in p.parents):
            raise HTTPException(400, 'Invalid document path')
        return target

    def move_plan(base, body):
        source, destination = target_for(base, body.path), target_for(base, body.destination)
        if not source.is_file() or sha(source.read_bytes()) != body.expected_sha256:
            raise HTTPException(409, 'Document changed. Reload before moving.')
        if destination.exists() or destination.is_symlink():
            raise HTTPException(409, 'Destination already exists; existing files were kept')
        source_path, destination_path = (path.relative_to(base).as_posix() for path in (source, destination))
        documents, size = {}, 0
        def unreadable(error):
            raise error
        for directory, folders, files in os.walk(base, onerror=unreadable):
            folders[:] = sorted(name for name in folders if not name.startswith('.') and not (Path(directory) / name).is_symlink())
            for name in sorted(files):
                path = Path(directory) / name
                if path.suffix != '.md' or name.startswith('.') or path.is_symlink():
                    continue
                if len(documents) >= 1000 or size >= 10_000_000:
                    raise HTTPException(413, 'Workspace is too large for a complete link preview. No files were changed.')
                safe = reader._workspace_child(base, path.relative_to(base))
                if safe is None:
                    continue
                with safe.open('rb') as stream:
                    raw = stream.read(500001)
                if len(raw) > 500000:
                    raise HTTPException(413, 'A Markdown document exceeds the link-preview size limit. No files were changed.')
                try:
                    raw.decode('utf-8')
                except UnicodeDecodeError as exc:
                    raise HTTPException(415, 'Link preview requires UTF-8 Markdown documents. No files were changed.') from exc
                documents[path.relative_to(base).as_posix()] = raw
                size += len(raw)
        original = documents.get(source_path)
        if original is None or sha(original) != body.expected_sha256:
            raise HTTPException(409, 'Document changed. Reload before moving.')
        updates, changes, warnings = {}, [], []
        moved = original
        for path, raw in sorted(documents.items()):
            text = raw.decode('utf-8')
            updated, count, notices = rewrite_links(text, source_path, destination_path, path, documents, str(base))
            warnings.extend(notices)
            if updated == text:
                continue
            if not editable(path):
                warnings.append(f'{path}: read-only content; {count} link(s) require manual review')
                continue
            content = updated.encode('utf-8')
            validate_content(destination_path if path == source_path else path, content)
            if path == source_path:
                moved = content
            else:
                updates[path] = (raw, content)
            changes.append({'path': path, 'sha256': sha(raw), 'replacements': count,
                            'diff': ''.join(difflib.unified_diff(text.splitlines(keepends=True), updated.splitlines(keepends=True), fromfile=path, tofile=destination_path if path == source_path else path))})
        validate_content(destination_path, moved)
        fingerprint = sha(json.dumps([str(base), source_path, destination_path, sha(original), sha(moved),
                                     [(path, sha(old), sha(new)) for path, (old, new) in sorted(updates.items())], sorted(warnings)], ensure_ascii=False).encode())
        preview = {'path': source_path, 'destination': destination_path, 'fingerprint': fingerprint,
                   'changes': changes, 'warnings': sorted(set(warnings))}
        return source, destination, moved, updates, preview

    @app.post('/api/workspace/document/move/preview')
    def preview_move(request: Request, body: DocumentMove):
        base = private_write_target(request, body.slug)
        try:
            with workspace_write_lock(base):
                return move_plan(base, body)[-1]
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Retry shortly.') from exc
        except OSError as exc:
            raise HTTPException(503, 'Could not read all linked documents. No files were changed.') from exc

    @app.get('/api/workspace/search')
    def search(request: Request, q: str = Query(min_length=1, max_length=200), slug: str | None = None):
        if not q.strip():
            raise HTTPException(422, 'Enter search text')
        try:
            return reader.search_at(read_target(request, slug), q.strip())
        except OSError as exc:
            raise HTTPException(503, 'Could not read workspace content; retry shortly') from exc

    @app.post('/api/workspace/document/move')
    def move(request: Request, body: DocumentMove):
        base = private_write_target(request, body.slug)
        try:
            with workspace_write_lock(base):
                if body.update_links:
                    if not body.expected_plan:
                        raise HTTPException(422, 'Preview the link changes before confirming this move')
                    source, destination, content, updates, preview = move_plan(base, body)
                    if body.expected_plan != preview['fingerprint']:
                        raise HTTPException(409, 'Linked documents changed. Preview the move again. No files were changed.')
                    # Publish the new target first and remove the old one last, so either path
                    # remains usable even if the process stops between individual atomic writes.
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        atomic_write(destination, content, create=True)
                    except FileExistsError as exc:
                        raise HTTPException(409, 'Destination already exists; existing files were kept') from exc
                    touched = []
                    try:
                        for path, (old, new) in updates.items():
                            target = target_for(base, path)
                            if sha(target.read_bytes()) != sha(old):
                                raise HTTPException(409, 'A linked document changed. Preview the move again.')
                            touched.append((target, old, new))
                            atomic_write(target, new)
                        if sha(target_for(base, body.path).read_bytes()) != body.expected_sha256:
                            raise HTTPException(409, 'The source changed during the move. Existing content was kept.')
                        if target_for(base, body.destination).read_bytes() != content:
                            raise HTTPException(409, 'The destination changed during the move. Existing content was kept.')
                        source.unlink()
                    except Exception as exc:
                        restored = True
                        for target, old, new in reversed(touched):
                            try:
                                current = target.read_bytes()
                                if current == new:
                                    atomic_write(target, old)
                                elif current != old:
                                    restored = False
                            except OSError:
                                restored = False
                        try:
                            if restored and destination.read_bytes() == content:
                                destination.unlink()
                            else:
                                restored = False
                        except OSError:
                            restored = False
                        if not restored:
                            raise HTTPException(503, 'Move needs recovery. Both paths were kept; reload and review the linked documents.') from exc
                        raise
                    return {'path': preview['destination'], 'updated_links': sum(change['replacements'] for change in preview['changes']),
                            'updated_documents': len(preview['changes']), 'warnings': preview['warnings']}
                source, destination = target_for(base, body.path), target_for(base, body.destination)
                if not source.is_file() or sha(source.read_bytes()) != body.expected_sha256:
                    raise HTTPException(409, 'Document changed. Reload before moving.')
                validate_content(body.destination, source.read_bytes())
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.link(source, destination)
                except FileExistsError as exc:
                    raise HTTPException(409, 'Destination already exists; existing files were kept') from exc
                try:
                    source.unlink()
                except OSError:
                    destination.unlink()
                    raise
                return {'path': body.destination}
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Retry shortly.') from exc
        except OSError as exc:
            raise HTTPException(503, 'Could not move document; reload before retrying') from exc

    @app.post('/api/workspace/document/delete')
    def delete(request: Request, body: DocumentChange):
        base = private_write_target(request, body.slug)
        try:
            with workspace_write_lock(base):
                target = target_for(base, body.path)
                if not target.is_file() or sha(target.read_bytes()) != body.expected_sha256:
                    raise HTTPException(409, 'Document changed. Reload before deleting.')
                target.unlink()
                return {'deleted': body.path}
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Retry shortly.') from exc
        except OSError as exc:
            raise HTTPException(503, 'Could not delete document; reload before retrying') from exc
    @app.get('/api/workspace/document')
    def read(request: Request, path: str, slug: str | None = None):
        base = read_target(request, slug)
        target = reader._workspace_child(base, path)
        if target is None:
            raise HTTPException(400, 'Invalid document path')
        if not target.is_file():
            raise HTTPException(404, 'Document not found')
        content = target.read_bytes()
        if len(content) > 500000:
            raise HTTPException(413, 'Document is too large')
        try:
            private_write_target(request, slug)
            writable = editable(path)
        except HTTPException:
            writable = False
        try:
            text = content.decode('utf-8')
        except UnicodeDecodeError as exc:
            raise HTTPException(415, 'This viewer supports UTF-8 text documents only') from exc
        return {'content': text, 'sha256': sha(content), 'writable': writable}

    @app.put('/api/workspace/document')
    def write(request: Request, body: DocumentWrite):
        base = private_write_target(request, body.slug)
        target = target_for(base, body.path)
        content = body.content.encode('utf-8')
        if len(content) > 500000:
            raise HTTPException(413, 'Document is too large')
        validate_content(body.path, content)
        try:
            with workspace_write_lock(base):
                current = target.read_bytes() if target.exists() else None
                if sha(current) != body.expected_sha256:
                    raise HTTPException(409, 'Document changed. Your draft was kept; reload before saving.')
                target.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(target, content)
                commit_sha, commit_error = None, None
                if body.commit:
                    from llm.ports import commit_workspace_paths
                    try:
                        commit_sha = commit_workspace_paths(base, [body.path], message=body.commit_message.strip() or 'Review Markdown document',
                            author=(request.headers.get('x-user-email') or subject_of(request), f'{subject_of(request)}@tina.local'))
                    except Exception:
                        commit_error = 'Document saved, but local Git commit failed. No remote was changed.'
                return {'sha256': sha(content), 'commit': commit_sha, 'commit_error': commit_error}
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Your draft was kept; retry shortly.') from exc
