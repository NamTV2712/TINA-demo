import hashlib
import subprocess

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from control_plane.workspace_documents import register
from control_plane.workspace_reader import WorkspaceReader


@pytest.fixture
def setup(tmp_path):
    base = tmp_path / 'owner'; base.mkdir()
    subprocess.run(['git', 'init', '-q', str(base)], check=True)
    reader = WorkspaceReader(str(tmp_path))
    def target(request, slug):
        if request.headers.get('x-user-id', 'owner') != 'owner' or slug == 'foreign':
            raise HTTPException(403, 'Not yours')
        return base
    app = FastAPI()
    register(app, lambda r: 'owner', target, target, reader)
    return TestClient(app), base


def test_save_preserves_concurrent_edits_and_commits_only_the_selected_path(setup):
    client, base = setup
    (base / 'unrelated.md').write_text('keep')
    subprocess.run(['git', '-C', str(base), 'add', 'unrelated.md'], check=True)
    body = {'path': 'wiki/test.md', 'content': '# First', 'expected_sha256': None, 'commit': True}
    result = client.put('/api/workspace/document', json=body)
    assert result.status_code == 200 and result.json()['commit']
    assert subprocess.check_output(['git', '-C', str(base), 'show', '--format=', '--name-only', 'HEAD']).decode().strip() == 'wiki/test.md'
    assert 'unrelated.md' in subprocess.check_output(['git', '-C', str(base), 'diff', '--cached', '--name-only']).decode()
    loaded = client.get('/api/workspace/document?path=wiki/test.md').json()
    assert loaded['sha256'] == hashlib.sha256(b'# First').hexdigest()
    (base / 'wiki/test.md').write_text('Changed elsewhere')
    assert client.put('/api/workspace/document', json=body | {'expected_sha256': loaded['sha256'], 'content': 'draft'}).status_code == 409
    assert (base / 'wiki/test.md').read_text() == 'Changed elsewhere'


def test_rejects_foreign_workspace_traversal_policy_and_invalid_entities(setup, tmp_path):
    client, base = setup
    for path in ['../secret.md', '/tmp/secret.md', '.claude/secret.md', 'policy/access.md']:
        assert client.put('/api/workspace/document', json={'path': path, 'content': 'bad'}).status_code in (400, 403)
    assert client.put('/api/workspace/document', json={'path': 'kg/entities/person/bad.md', 'content': 'missing schema'}).status_code == 422
    assert client.put('/api/workspace/document', json={'path': 'wiki/a.md', 'content': 'bad', 'slug': 'foreign'}).status_code == 403
    (base / 'wiki').symlink_to(tmp_path)
    assert client.put('/api/workspace/document', json={'path': 'wiki/a.md', 'content': 'bad'}).status_code == 400
