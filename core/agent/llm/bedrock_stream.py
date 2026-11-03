"""Decode native Anthropic InvokeModelWithResponseStream probes.

Bedrock frames JSON chunks in AWS event-stream messages with two CRCs; HTTP 200
alone does not mean the model finished. Keep this separate from CLI execution.
"""
from __future__ import annotations

import base64
import json
import struct
import zlib


def decode_anthropic_stream(raw: bytes) -> dict:
    offset = 0
    response = None
    blocks: dict[int, dict] = {}
    arguments: dict[int, list[str]] = {}
    stopped = False
    while offset < len(raw):
        if len(raw) - offset < 16:
            raise ValueError("Bedrock stream ended inside a frame.")
        length, header_length, prelude_crc = struct.unpack_from(">III", raw, offset)
        if length < 16 + header_length or length > len(raw) - offset:
            raise ValueError("Invalid Bedrock stream frame length.")
        frame = raw[offset:offset + length]
        if (zlib.crc32(frame[:8]) != prelude_crc
                or zlib.crc32(frame[:-4]) != struct.unpack(">I", frame[-4:])[0]):
            raise ValueError("Invalid Bedrock stream checksum.")
        payload = json.loads(frame[12 + header_length:-4])
        offset += length
        if not isinstance(payload, dict) or "bytes" not in payload:
            message = payload.get("message", "Bedrock streaming error.") if isinstance(payload, dict) else "Invalid Bedrock event."
            raise ValueError(str(message)[:300])
        event = json.loads(base64.b64decode(payload["bytes"], validate=True))
        kind = event.get("type")
        if kind == "message_start":
            response = dict(event["message"])
        elif kind == "content_block_start":
            index = event["index"]
            if not isinstance(index, int) or not 0 <= index < 128:
                raise ValueError("Invalid Bedrock content block index.")
            blocks[index] = dict(event["content_block"])
            arguments[index] = []
        elif kind == "content_block_delta":
            index, delta = event["index"], event["delta"]
            block = blocks[index]
            if delta["type"] == "input_json_delta":
                arguments[index].append(delta.get("partial_json", ""))
            else:
                field = {"text_delta": "text", "thinking_delta": "thinking",
                         "signature_delta": "signature"}.get(delta["type"])
                if field:
                    block[field] = block.get(field, "") + delta.get(field, "")
        elif kind == "content_block_stop":
            index = event["index"]
            if arguments.get(index):
                blocks[index]["input"] = json.loads("".join(arguments[index]))
        elif kind == "message_delta" and response is not None:
            response.update(event.get("delta", {}))
        elif kind == "message_stop":
            stopped = True
    if response is None or not stopped:
        raise ValueError("Bedrock stream disconnected before message completion.")
    response["content"] = [blocks[index] for index in sorted(blocks)]
    return response
