from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from control_plane.knowledge_research import research_instructions


def test_research_uses_private_destination_and_distinguishes_evidence(tmp_path):
    mounts = [
        SimpleNamespace(slug='team', path=str(tmp_path / 'team'), role='shared', write=True, primary=True),
        SimpleNamespace(slug='personal', path=str(tmp_path / 'personal'), role='private', write=True, primary=False),
    ]
    result = research_instructions(mounts)
    assert str(tmp_path / 'personal' / 'notes' / 'research') in result
    assert 'meeting | repo | web' in result
    assert 'verified_at' in result and 'revision' in result and 'commit' in result
    assert 'Do not send private workspace or meeting content to public web search' in result
    assert 'canonical transcript' in result
    assert not (tmp_path / 'personal').exists()


def test_research_requires_private_write_mount(tmp_path):
    with pytest.raises(HTTPException) as error:
        research_instructions([SimpleNamespace(slug='viewer', path=str(tmp_path), role='shared', write=False)])
    assert error.value.status_code == 409


def test_research_refuses_symlinked_destination_outside_workspace(tmp_path):
    workspace = tmp_path / 'workspace'
    outside = tmp_path / 'outside'
    workspace.mkdir(); outside.mkdir()
    (workspace / 'notes').symlink_to(outside, target_is_directory=True)
    with pytest.raises(HTTPException):
        research_instructions([SimpleNamespace(slug='personal', path=str(workspace), role='private', write=True)])
