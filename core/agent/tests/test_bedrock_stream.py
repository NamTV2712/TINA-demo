import json

import pytest

from llm.bedrock_stream import decode_anthropic_stream
from tests.test_claude_cli_wire import _anthropic_events, _aws_event


def _stream(events):
    return b"".join(_aws_event(event) for event in events)


def test_stream_decoder_reads_the_same_native_tool_frames_as_the_pinned_cli():
    events = _anthropic_events("test-model", {"type": "tool_use", "id": "tool-1",
                "name": "connection_check", "input": {"nonce": "probe"}})
    response = decode_anthropic_stream(_stream(events))
    assert response["stop_reason"] == "tool_use"
    assert response["content"] == [{"type": "tool_use", "id": "tool-1",
                                   "name": "connection_check", "input": {"nonce": "probe"}}]


def test_stream_decoder_reads_final_text_and_stop_reason():
    response = decode_anthropic_stream(_stream(_anthropic_events("test", {"type": "text", "text": "OK"})))
    assert response["stop_reason"] == "end_turn"
    assert response["content"] == [{"type": "text", "text": "OK"}]


@pytest.mark.parametrize("position", [0, 8, -1])
def test_invalid_stream_crc_or_frame_length_is_not_success(position):
    raw = bytearray(_stream(_anthropic_events("test", {"type": "text", "text": "OK"})))
    raw[position] ^= 1
    with pytest.raises(ValueError):
        decode_anthropic_stream(bytes(raw))


def test_http_200_with_a_disconnected_stream_is_not_success():
    events = _anthropic_events("test", {"type": "text", "text": "OK"})
    with pytest.raises(ValueError, match="disconnected"):
        decode_anthropic_stream(_stream(events[:-1]))
    with pytest.raises(ValueError, match="frame"):
        decode_anthropic_stream(_stream(events)[:-3])


def test_default_http_probe_decodes_aws_frames_before_grading_tools(monkeypatch):
    from control_plane import config_test
    raw = _stream(_anthropic_events("test", {"type": "text", "text": "OK"}))
    class Response:
        status = 200
        headers = {"Content-Type": "application/vnd.amazon.eventstream"}
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, _limit=None): return raw
    monkeypatch.setattr(config_test.urllib.request, "urlopen", lambda *_args, **_kwargs: Response())
    status, body = config_test._post("https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke-with-response-stream", {}, {})
    assert status == 200 and json.loads(body)["content"][0]["text"] == "OK"
