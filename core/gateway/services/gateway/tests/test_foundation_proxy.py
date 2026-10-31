import json

from starlette.testclient import TestClient
from gateway import create_app
from conftest import FakeAuthorizer, FakeDownstream, FakeRedis, VALID_KEY


def test_foundation_routes_forward_with_resolved_owner_and_tx_scope():
    downstream = FakeDownstream()
    api = TestClient(create_app(FakeAuthorizer(), downstream, FakeRedis()))
    headers = {'x-api-key':VALID_KEY,'x-user-id':'999'}
    uid = 'a' * 64
    for method, path in [('get','/transcripts/by-id/1/foundation'), ('get',f'/transcripts/by-id/1/replicas/{uid}'), ('put',f'/transcripts/by-id/1/replicas/{uid}')]:
        response = getattr(api,method)(path,headers=headers,**({'json':{'expected_revision':0,'snapshot':{}}} if method=='put' else {}))
        assert response.status_code == 200
        assert downstream.last['headers']['x-user-id']=='7'
        assert downstream.last['url'].endswith(path)
        if method=='put': assert json.loads(downstream.last['content'])['expected_revision']==0
    assert api.get('/transcripts/by-id/1/replicas/not-a-hash',headers=headers).status_code == 422
    restricted=TestClient(create_app(FakeAuthorizer(user={'user_id':7,'scopes':['bot']}),FakeDownstream(),FakeRedis()))
    assert restricted.get('/transcripts/by-id/1/foundation',headers=headers).status_code==403
