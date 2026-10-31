"""test_meeting_postprocess_offline.py — the offline LLM-postprocessing harness (WS3).

The critical untested seam: a FIXED transcript fed through ``worker.meeting_card_turn`` (and
``meeting_doc_turn``) with DETERMINISTIC llm-port fakes — no redis, no docker, no live provider.
This makes the whole "fixed transcript in → expected entities out" pipeline reproducible:

  fixture segments → meeting_card_turn → CompletionPort fake → parse_notes / parse_cards → shapes
  deduped cards    → meeting_doc_turn  → CompletionPort summary + validated single-file commit

Both stages take injectable ``completion`` ports; the document writer serializes and validates its
single entity path before committing it.

Also covers WS1: the auth-error path (a misconfigured key/base_url → a DISTINCT ``auth-error`` event,
not the generic ``model-error``) and the boot preflight guard.
"""
from __future__ import annotations

import json
import unittest.mock as mock
from pathlib import Path

from llm import CompletionResult, LLMAuthError, LLMError
from worker import worker

FIXTURE = Path(__file__).resolve().parents[1] / "eval" / "replay" / "gamestop-allin.jsonl"


# ── fixture helpers ───────────────────────────────────────────────────────────────────────────────

def _load_fixture_segments(limit: int) -> list[dict]:
    """A FIXED slice of the committed gamestop transcript, shaped as serve_meeting shapes a beat's
    segments (segment_id + rewrite_pass), so the input to meeting_card_turn is deterministic."""
    segments: list[dict] = []
    with FIXTURE.open(encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= limit:
                break
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            segments.append({
                "segment_id": f"seg-{i}",
                "speaker": d["speaker"],
                "text": d["text"],
                "start": float(d.get("start", i * 5.0)),
                "rewrite_pass": 1,
            })
    return segments


def _fake_completion(reply: str = "", *, raises: Exception | None = None):
    """A DETERMINISTIC CompletionPort: records the prompt/model it was called with, then returns the
    canned reply — or raises, for the error-path tests."""
    captured: dict = {}

    class _Fake:
        name = "fake"

        def complete(self, prompt, *, system=None, model=None):
            captured["prompt"] = prompt
            captured["model"] = model
            if raises is not None:
                raise raises
            return CompletionResult(text=reply, model=model or "fake-model")

    return _Fake(), captured


# The pre-recorded model reply for the fixed 4-segment slice: one note per input id (echoing speaker)
# plus the concrete named entities surfaced from those lines (person + company kinds only).
_RECORDED_REPLY = json.dumps({
    "notes": [
        {"id": "seg-0", "speaker": "Ryan Cohen", "chapter": "",
         "text": "Everyone hates GameStop and the media wants us to fail."},
        {"id": "seg-1", "speaker": "Jason Calacanis", "chapter": "",
         "text": "The board shows up to a few meetings and the management team is overpaid."},
        {"id": "seg-2", "speaker": "Chamath Palihapitiya", "chapter": "",
         "text": "Nothing is more American than risking your own capital."},
        {"id": "seg-3", "speaker": "David Sacks", "chapter": "",
         "text": "AppLovin started with an $8 domain and no VC funding."},
    ],
    "cards": [
        {"kind": "person", "title": "Ryan Cohen", "body": "GameStop chairman on the call."},
        {"kind": "company", "title": "GameStop", "body": "The company under discussion."},
        {"kind": "company", "title": "AppLovin", "body": "Ad platform cited as a bootstrapped success."},
        # an off-allowlist kind the parser must filter out (card_kinds gate)
        {"kind": "decision", "title": "Should be dropped", "body": "not an allowed kind"},
    ],
})


# ── the offline harness: fixed transcript in → expected entities out ───────────────────────────────

def test_offline_meeting_card_turn_extracts_notes_and_cards(tmp_path):
    """The whole card-turn pipeline, offline: a FIXED 4-line transcript through a deterministic
    CompletionPort fake yields the expected processed notes (one per input id, first-person, frozen
    flags) and the expected entity cards (filtered to the allowed kinds)."""
    segments = _load_fixture_segments(4)
    completion, captured = _fake_completion(_RECORDED_REPLY)

    evs = list(worker.meeting_card_turn(
        tmp_path, segments, model="openrouter/free",
        card_kinds=["person", "company", "product"], completion=completion,
    ))

    # The card prompt carried the fixed transcript lines (so a real model would see the same input),
    # and the per-beat model reached the port.
    assert "Everyone hates GameStop" in captured["prompt"]
    assert captured["model"] == "openrouter/free"

    notes = [e["note"] for e in evs if e["type"] == "note"]
    cards = [e["card"] for e in evs if e["type"] == "card"]

    # one note per input segment id, in order, with the right speakers
    assert [n["id"] for n in notes] == ["seg-0", "seg-1", "seg-2", "seg-3"]
    assert [n["speaker"] for n in notes] == [
        "Ryan Cohen", "Jason Calacanis", "Chamath Palihapitiya", "David Sacks",
    ]
    # pass 1 segments are not frozen, and each note carries its source timestamp
    assert all(n["pass"] == 1 and n["frozen"] is False for n in notes)
    assert notes[0]["t"] == 0.1
    assert notes[0]["text"].startswith("Everyone hates GameStop")

    # cards filtered to the allowed kinds — the `decision` card is dropped, the entities survive
    assert {c["title"] for c in cards} == {"Ryan Cohen", "GameStop", "AppLovin"}
    assert all(c["kind"] in {"person", "company", "product"} for c in cards)
    assert "Should be dropped" not in {c["title"] for c in cards}
    # no error events on the happy path
    assert not any(e["type"] in {"model-error", "auth-error"} for e in evs)


def test_offline_meeting_card_turn_falls_back_when_reply_omits_notes(tmp_path):
    """If the replayed reply has cards but no notes matching the input ids, the turn surfaces a
    model-error AND falls back to deterministic processed notes (one per input segment) — proving the
    no-silent-drop guarantee on a fixed transcript."""
    reply = json.dumps({"notes": [], "cards": [{"kind": "company", "title": "GameStop", "body": "x"}]})
    segments = _load_fixture_segments(2)
    completion, _ = _fake_completion(reply)

    evs = list(worker.meeting_card_turn(tmp_path, segments, model="openrouter/free", completion=completion))

    assert evs[0]["type"] == "model-error"
    assert evs[0]["error"]["message"] == "model response did not include processed transcript notes"
    fallback = [e["note"] for e in evs if e["type"] == "note"]
    assert [n["id"] for n in fallback] == ["seg-0", "seg-1"]  # fallback covered every input line


def test_offline_meeting_doc_turn_authors_entity_from_fixed_cards(tmp_path):
    """The post-meeting writer compiles fixed cards through a CompletionPort and commits only its
    validated meeting entity, leaving unrelated workspace changes untouched."""
    import subprocess

    import contracts
    from shared.adapters import parse_entity

    native = "gme-allin-001"
    cards = [
        {"kind": "person", "title": "Ryan Cohen", "body": "chairman"},
        {"kind": "company", "title": "GameStop", "body": "the company"},
        {"kind": "company", "title": "AppLovin", "body": "ad platform"},
    ]
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "tina@example.test"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "TINA"], cwd=tmp_path, check=True)
    (tmp_path / "README.md").write_text("seed\n")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=tmp_path, check=True)
    (tmp_path / "unrelated.md").write_text("leave this uncommitted for the next turn\n")
    completion, _captured = _fake_completion(
        "Ryan Cohen defended GameStop and cited AppLovin as a bootstrapped success."
    )
    evs = list(worker.meeting_doc_turn(
        tmp_path, cards, native=native, meeting_id=native, session_uid=native,
        platform="google_meet", date="2026-06-27", title="GME All-In", completion=completion,
    ))

    assert any(e.get("type") == "commit" for e in evs)
    doc = (tmp_path / "kg" / "entities" / "meeting" / f"{native}.md").read_text()
    frontmatter, body = parse_entity(doc)
    contracts.validate_entity_frontmatter(frontmatter)
    assert frontmatter["type"] == "meeting" and frontmatter["id"] == native
    assert frontmatter["platform"] == "google_meet" and frontmatter["date"] == "2026-06-27"
    assert "Ryan Cohen defended GameStop" in body
    assert "[[Ryan Cohen]]" in body and "[[GameStop]]" in body and "[[AppLovin]]" in body
    committed = subprocess.run(
        ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        cwd=tmp_path, capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    assert committed == [f"kg/entities/meeting/{native}.md"]
    assert "unrelated.md" in subprocess.run(
        ["git", "status", "--porcelain"], cwd=tmp_path, capture_output=True, text=True, check=True,
    ).stdout


def test_offline_meeting_doc_turn_rejects_unsafe_native_before_completion(tmp_path):
    completion, captured = _fake_completion("summary")
    events = list(worker.meeting_doc_turn(
        tmp_path, [], native="../escape", meeting_id="m1", session_uid="s1",
        platform="google_meet", date="2026-06-27", title="Meeting", completion=completion,
    ))

    assert events and events[0]["type"] == "model-error"
    assert captured == {}
    assert not (tmp_path / "kg" / "entities" / "escape.md").exists()


# ── WS1: the auth-error path (distinct from the generic model-error) ───────────────────────────────

def test_offline_card_turn_emits_auth_error_on_401_done_reply(tmp_path):
    """A 401 from the provider (key/endpoint mismatch) surfaces as a DISTINCT auth-error carrying the
    provider host + the BASE_URL-vs-KEY hint — NOT the opaque generic model-error. Here the adapter
    raised the typed ``LLMAuthError`` (what the real openai-compat/anthropic adapters do on 401)."""
    segments = _load_fixture_segments(2)
    err = "401 from https://api.anthropic.com: {\"error\":{\"message\":\"No auth credentials found\"}}"
    completion, _ = _fake_completion(raises=LLMAuthError(err))

    with mock.patch.dict("os.environ", {"TINA_LLM_BASE_URL": "", "ANTHROPIC_BASE_URL": "https://api.anthropic.com"}):
        evs = list(worker.meeting_card_turn(tmp_path, segments, model="openrouter/free", completion=completion))

    assert len(evs) == 1
    ev = evs[0]
    assert ev["type"] == "auth-error"  # distinct event, not "model-error"
    assert ev["error"]["provider_host"] == "api.anthropic.com"
    assert "TINA_LLM_BASE_URL" in ev["error"]["hint"] and "TINA_LLM_API_KEY" in ev["error"]["hint"]
    assert "ANTHROPIC_BASE_URL" in ev["error"]["hint"] and "ANTHROPIC_AUTH_TOKEN" in ev["error"]["hint"]
    assert ev["error"]["stage"] == "meeting-card"


def test_offline_card_turn_upgrades_untyped_401_to_auth_error(tmp_path):
    """The 401 may ride an UNTYPED failure (a transport/CLI error whose text carries the signature) —
    the signature scan still upgrades it to auth-error."""
    segments = _load_fixture_segments(2)
    completion, _ = _fake_completion(
        raises=RuntimeError("Request failed: 401 Unauthorized (invalid bearer token)"))

    with mock.patch.dict("os.environ", {"TINA_LLM_BASE_URL": "", "ANTHROPIC_BASE_URL": "https://openrouter.ai/api"}):
        evs = list(worker.meeting_card_turn(tmp_path, segments, model="openrouter/free", completion=completion))

    assert [e["type"] for e in evs] == ["auth-error"]
    assert evs[0]["error"]["provider_host"] == "openrouter.ai"


def test_offline_card_turn_non_auth_failure_stays_generic_model_error(tmp_path):
    """A non-auth failure (e.g. a model timeout) must NOT be misclassified as an auth-error — it stays a
    generic model-error so the auth signal remains meaningful."""
    segments = _load_fixture_segments(2)
    completion, _ = _fake_completion(raises=LLMError("upstream timeout (504)"))

    evs = list(worker.meeting_card_turn(tmp_path, segments, model="openrouter/free", completion=completion))

    assert [e["type"] for e in evs] == ["model-error"]


def test_card_turn_resolves_completion_factory_seam(tmp_path):
    """With no explicit ``completion``, the card turn resolves the adapter through the
    ``worker.completion_factory`` seam — the patch point tests and embedders rely on."""
    segments = _load_fixture_segments(2)
    completion, captured = _fake_completion(_RECORDED_REPLY)

    with mock.patch.object(worker, "completion_factory", lambda: completion):
        evs = list(worker.meeting_card_turn(tmp_path, segments, model="openrouter/free"))

    assert "prompt" in captured  # the factory-built adapter was driven
    assert any(e["type"] == "note" for e in evs)


# ── WS1: the boot preflight guard ──────────────────────────────────────────────────────────────────

def test_preflight_guard_flags_openrouter_token_to_anthropic_host():
    warn = worker.preflight_provider_guard(
        base_url="https://api.anthropic.com", token="sk-or-v1-deadbeef",
    )
    assert warn is not None
    assert "PROVIDER MISMATCH" in warn and "openrouter" in warn.lower()


def test_preflight_guard_flags_anthropic_token_to_openrouter_host():
    warn = worker.preflight_provider_guard(
        base_url="https://openrouter.ai/api", token="sk-ant-api03-deadbeef",
    )
    assert warn is not None
    assert "PROVIDER MISMATCH" in warn and "api.anthropic.com" in warn


def test_preflight_guard_silent_on_consistent_pairs():
    # the correct prod pairing (sk-or- → openrouter) is silent
    assert worker.preflight_provider_guard(
        base_url="https://openrouter.ai/api", token="sk-or-v1-deadbeef",
    ) is None
    # sk-ant- → anthropic is silent
    assert worker.preflight_provider_guard(
        base_url="https://api.anthropic.com", token="sk-ant-api03-deadbeef",
    ) is None
    # a custom/third-party gateway is not judged (conservative — never nags)
    assert worker.preflight_provider_guard(
        base_url="https://llm.internal.corp/v1", token="sk-or-v1-deadbeef",
    ) is None
    # missing values can't be judged
    assert worker.preflight_provider_guard(base_url="", token="") is None


def test_provider_host_extracts_netloc():
    assert worker.provider_host("https://openrouter.ai/api") == "openrouter.ai"
    assert worker.provider_host("https://api.anthropic.com") == "api.anthropic.com"
    assert worker.provider_host("") == "unknown"


def test_looks_like_auth_failure_signatures():
    assert worker.looks_like_auth_failure("HTTP 401 Unauthorized")
    assert worker.looks_like_auth_failure("invalid bearer token")
    assert worker.looks_like_auth_failure("authentication_error: invalid x-api-key")
    assert worker.looks_like_auth_failure(RuntimeError("401 No auth credentials found"))
    assert worker.looks_like_auth_failure("Not logged in · Please run /login")  # claude CLI, no/expired cred
    assert not worker.looks_like_auth_failure("upstream timeout 504")
    assert not worker.looks_like_auth_failure("")
    assert not worker.looks_like_auth_failure(None)
