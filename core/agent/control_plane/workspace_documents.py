"""Explicit owner Markdown edits with content preconditions and path-only local commits."""
import hashlib
import os
import tempfile
from pathlib import Path

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from shared.adapters import WorkspaceBusyError, parse_entity, workspace_write_lock


def sha(content):
    return hashlib.sha256(content).hexdigest() if content is not None else None


class DocumentWrite(BaseModel):
    model_config = {'extra': 'forbid'}
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=500000)
    expected_sha256: str | None = Field(pattern=r'^[0-9a-f]{64}$', default=None)
    slug: str | None = None
    commit: bool = False


def editable(path):
    p = Path(path)
    return (not p.is_absolute() and p.suffix == '.md' and all(not part.startswith('.') for part in p.parts)
            and (path == 'README.md' or p.parts[0] in {'wiki', 'kg', 'notes', 'sources', 'concepts', 'docs'}))


def register(app, subject_of, read_target, private_write_target, reader):
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
        if not editable(body.path):
            raise HTTPException(403, 'Only content Markdown documents can be edited here')
        target = reader._workspace_child(base, body.path)
        raw = base / body.path
        if target is None or any(p.is_symlink() for p in [raw, *raw.parents] if base in p.parents):
            raise HTTPException(400, 'Invalid document path')
        content = body.content.encode('utf-8')
        if len(content) > 500000:
            raise HTTPException(413, 'Document is too large')
        if body.path.startswith('kg/entities/') and raw.name not in ('index.md', 'log.md'):
            import contracts
            try:
                frontmatter, _ = parse_entity(body.content)
                contracts.validate_entity_frontmatter(frontmatter)
            except Exception as exc:
                raise HTTPException(422, 'Invalid Wiki entity frontmatter; existing document was kept') from exc
        try:
            with workspace_write_lock(base):
                current = target.read_bytes() if target.exists() else None
                if sha(current) != body.expected_sha256:
                    raise HTTPException(409, 'Document changed. Your draft was kept; reload before saving.')
                target.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as out:
                    temporary = Path(out.name)
                    out.write(content)
                try:
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
                commit_sha, commit_error = None, None
                if body.commit:
                    from llm.ports import commit_workspace_paths
                    try:
                        commit_sha = commit_workspace_paths(base, [body.path], message='Review Markdown document',
                            author=(request.headers.get('x-user-email') or subject_of(request), f'{subject_of(request)}@tina.local'))
                    except Exception:
                        commit_error = 'Document saved, but local Git commit failed. No remote was changed.'
                return {'sha256': sha(content), 'commit': commit_sha, 'commit_error': commit_error}
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Your draft was kept; retry shortly.') from exc
