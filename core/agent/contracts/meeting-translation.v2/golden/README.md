# Grouped translation fixtures

Two consecutive ASR fragments form one original/English phrase with preserved source IDs.

`Translation.grouped.json` is a complete v2 snapshot with one translated group whose `members`
contain both original fragments. Speaker identity and start/end times belong to the whole group;
the English result is returned once. The matching schema is `../translation.schema.json`.

Runtime grouping, buffering, failed-provider and edited-source cases are covered by
`core/agent/tests/test_translation_groups.py` and `core/agent/tests/test_meeting_translation.py`
(paths relative to the repository root).
