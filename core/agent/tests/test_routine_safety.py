from pathlib import Path
from types import SimpleNamespace

from control_plane import workspace_routines as routines
from control_plane.workspace_reader import WorkspaceReader
from tests.test_routines import _FakeScheduler, _app

BODY = '---\nenabled: true\ncron: "0 9 * * *"\ntimezone: Asia/Ho_Chi_Minh\nprompt: Summarize notes\n---\nKeep source links.\n'


def make_file(root, relative, text=BODY):
    path = root / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)
    return path


def test_delete_removes_enabled_or_disabled_file_and_never_resurrects(tmp_path):
    for enabled in (True, False):
        make_file(tmp_path, 'u_jane/routines/daily.md', BODY.replace('enabled: true', f'enabled: {str(enabled).lower()}'))
        scheduler = _FakeScheduler()
        routines.reconcile_workspace_routines('u_jane', scheduler=scheduler, invocations_url='http://agent/invocations', workspaces_dir=tmp_path)
        client, _ = _app(scheduler, reader=WorkspaceReader(str(tmp_path)))
        card = client.get('/api/routines').json()['routines'][0]
        response = client.delete('/api/routines/' + card['id'], params={'expected_sha256': card['expected_sha256']})
        assert response.status_code == 200
        routines.reconcile_workspace_routines('u_jane', scheduler=scheduler, invocations_url='http://agent/invocations', workspaces_dir=tmp_path)
        assert scheduler.jobs == []
        assert not (tmp_path / 'u_jane/routines/daily.md').exists()


def test_edit_uses_stable_identity_validates_and_rejects_stale_drafts(tmp_path):
    path = make_file(tmp_path, 'u_jane/routines/daily.md')
    scheduler = _FakeScheduler(); client, _ = _app(scheduler, reader=WorkspaceReader(str(tmp_path)))
    card = client.get('/api/routines').json()['routines'][0]
    body = {'name': 'Vietnam morning', 'cron': '30 9 * * mon-fri', 'timezone': 'Asia/Ho_Chi_Minh',
            'prompt': 'Summarize yesterday', 'expected_sha256': card['expected_sha256']}
    assert client.patch('/api/routines/' + card['id'], json=body).status_code == 200
    updated = client.get('/api/routines').json()['routines'][0]
    assert updated['id'] == card['id'] and updated['routine_name'] == 'daily'
    assert updated['name'] == 'Vietnam morning' and 'Keep source links.' in path.read_text()
    assert scheduler.jobs[0]['timezone'] == 'Asia/Ho_Chi_Minh'
    assert client.patch('/api/routines/' + card['id'], json=body).status_code == 409
    assert client.delete('/api/routines/' + card['id'], params={'expected_sha256': card['expected_sha256']}).status_code == 409
    body['expected_sha256'] = updated['expected_sha256']
    assert client.patch('/api/routines/' + card['id'], json=body | {'timezone': 'Bad/Zone'}).status_code == 400
    assert client.patch('/api/routines/' + card['id'], json=body | {'cron': 'bad'}).status_code == 400
    assert client.patch('/api/routines/' + card['id'] + '/enabled', json={'enabled': False, 'expected_sha256': updated['expected_sha256']}).status_code == 200
    assert scheduler.jobs == []


def test_attached_routines_have_distinct_ids_and_inactive_mount_is_cancelled(tmp_path, monkeypatch):
    baseline = make_file(tmp_path, 'u_jane/routines/daily.md')
    attached = make_file(tmp_path, '.attached/u_jane/project/routines/daily.md')
    active = [SimpleNamespace(path=str(baseline.parent.parent), slug='seed', write=True, role='private'),
              SimpleNamespace(path=str(attached.parent.parent), slug='project', write=True, role='private')]
    monkeypatch.setattr(routines, 'active_workspaces', lambda root, subject: active)
    scheduler = _FakeScheduler()
    routines.reconcile_all_workspace_routines(scheduler=scheduler, invocations_url='http://agent/invocations', workspaces_dir=tmp_path)
    cards = routines.routine_cards_for_subject('u_jane', jobs=scheduler.jobs, workspaces_dir=tmp_path)
    assert len(cards) == 2 and cards[0]['id'] != cards[1]['id']
    job = next(j for j in scheduler.jobs if j['metadata'].get('workspace_slug') == 'project')
    assert job['request']['body']['context']['ref']['uri'] == 'workspace://project'
    active.pop()
    result = routines.reconcile_workspace_routines('u_jane', scheduler=scheduler, invocations_url='http://agent/invocations', workspaces_dir=tmp_path)
    assert result.cancelled == 1 and len(scheduler.jobs) == 1


def test_foreign_or_symlink_source_cannot_be_mutated_over_api(tmp_path):
    victim = make_file(tmp_path, 'victim/routines/private.md')
    path = tmp_path / 'u_jane/routines/stolen.md'; path.parent.mkdir(parents=True); path.symlink_to(victim)
    client, _ = _app(_FakeScheduler(), reader=WorkspaceReader(str(tmp_path)))
    assert client.get('/api/routines').json()['routines'] == []
    assert client.patch('/api/routines/stolen/enabled', json={'enabled': False}).status_code == 404
    assert victim.read_text() == BODY


def test_changing_only_timezone_replaces_job_and_preserves_utc_legacy(tmp_path):
    path = make_file(tmp_path, 'u_jane/routines/daily.md', BODY.replace('timezone: Asia/Ho_Chi_Minh\n', ''))
    scheduler = _FakeScheduler()
    kwargs = dict(scheduler=scheduler, invocations_url='http://agent/invocations', workspaces_dir=tmp_path)
    routines.reconcile_workspace_routines('u_jane', **kwargs)
    assert scheduler.jobs[0].get('timezone', 'UTC') == 'UTC'
    path.write_text(BODY)
    result = routines.reconcile_workspace_routines('u_jane', **kwargs)
    assert result.cancelled == 1 and result.scheduled == 1
    assert scheduler.jobs[0]['timezone'] == 'Asia/Ho_Chi_Minh'


def test_dispatch_runs_in_original_active_private_workspace_and_refuses_unmounted(monkeypatch, tmp_path):
    import pytest
    from control_plane import dispatch
    from shared.config import load_settings
    from shared.units import make_dispatch, entrypoint
    mounts = [{'slug': 'other', 'path': str(tmp_path / 'other'), 'role': 'private', 'write': True, 'primary': True},
              {'slug': 'project', 'path': str(tmp_path / 'project'), 'role': 'private', 'write': True}]
    monkeypatch.setattr(dispatch, 'build_mount_set', lambda *_: mounts)
    invocation = make_dispatch(subject='u_jane', trigger='scheduled', start=entrypoint(inline='Summarize'),
                               context={'kind': 'generic', 'ref': {'uri': 'workspace://project'}})
    env = dispatch.build_unit_env(load_settings(), invocation, unit_id='test', token='test')
    assert env['TINA_WORKSPACE_PATH'] == str(tmp_path / 'project')
    mounts.pop()
    with pytest.raises(ValueError, match='no longer active'):
        dispatch.build_unit_env(load_settings(), invocation, unit_id='test', token='test')
