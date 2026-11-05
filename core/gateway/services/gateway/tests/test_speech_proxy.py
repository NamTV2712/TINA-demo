from starlette.testclient import TestClient
from gateway import create_app
from conftest import FakeAuthorizer, FakeDownstream, FakeRedis, VALID_KEY


def test_speech_receipts_keep_owner_scope_and_stop_query():
    downstream = FakeDownstream()
    api = TestClient(create_app(FakeAuthorizer(), downstream, FakeRedis()))
    headers = {'x-api-key': VALID_KEY, 'x-user-id': '999'}
    identifier = '00000000-0000-4000-8000-000000000001'
    path = '/bots/google_meet/synthetic/speak'
    assert api.get(path + '/' + identifier, headers=headers).status_code == 200
    assert downstream.last['headers']['x-user-id'] == '7'
    assert downstream.last['url'].endswith(path + '/' + identifier)
    assert api.delete(path + '?command_id=' + identifier, headers=headers).status_code == 200
    assert downstream.last['params']['command_id'] == identifier
    restricted = TestClient(create_app(FakeAuthorizer(user={'user_id': 7, 'scopes': ['tx']}),
                                      FakeDownstream(), FakeRedis()))
    assert restricted.get(path + '/' + identifier, headers=headers).status_code == 403
    assert api.post('/bots/internal/callback/speech', headers=headers, json={}).status_code == 404
