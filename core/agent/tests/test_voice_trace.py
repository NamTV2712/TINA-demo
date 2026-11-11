"""Trace UUIDs cross stages; private content and arbitrary metadata never enter these logs."""
import json
import logging
from uuid import UUID

import pytest

from shared.voice_trace import voice_span, voice_trace_id


def test_nested_trace_records_only_allowlisted_metrics_and_restores_context(caplog):
    identifier = '00000000-0000-4000-8000-000000000123'
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'):
        with voice_span('answer', identifier) as metrics:
            metrics.update(input_sources=10, output_sources=2, question='PRIVATE QUESTION', token='SECRET')
            with pytest.raises(ValueError), voice_span('generation'):
                raise ValueError('PRIVATE PROVIDER BODY')
    records = [json.loads(r.message) for r in caplog.records]
    assert len(records) == 2 and {r['request_id'] for r in records} == {identifier}
    assert records[0]['status'] == 'error' and records[1]['input_sources'] == 10
    assert all(r['elapsed_ms'] >= 0 for r in records)
    assert 'PRIVATE' not in caplog.text and 'SECRET' not in caplog.text
    assert voice_trace_id.get() is None


def test_untrusted_trace_header_is_replaced_with_a_uuid(caplog):
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'), voice_span('answer', 'SECRET\nheader'):
        pass
    record = json.loads(caplog.records[0].message)
    UUID(record['request_id'])
    assert 'SECRET' not in caplog.text
