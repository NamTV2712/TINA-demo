# Knowledge

Knowledge uses the authenticated user's mounted workspaces. Dashboard and Terminal share the
Gateway-backed document and meeting APIs; caller-supplied owner IDs never authorize a workspace.

## Documents

Dashboard offers a folder tree, filename and content search, Markdown source formatting, wikilinks,
per-file local commits with a custom message, and workspace history/diffs. Formatting inserts Markdown
at the current selection without converting the document or rewriting frontmatter. Drafts survive
client-side navigation and reloads in the same tab through browser session storage, partitioned by
account/workspace/file. The original content and SHA-256 are retained so a restored draft cannot
overwrite newer server edits. Save/discard removes the stored draft. Browser storage failures are
visible; closing the tab clears its session storage, so save before closing. The open document and
workspace are reflected in the URL, allowing reload to return to the same document.

`GET /api/workspace/search?q=...&slug=...` performs literal, case-insensitive Unicode search in visible
Markdown files. Each workspace search reads at most 1,000 documents / about 10 MB, skips documents over
500 KB, and returns at most 50 matching lines. A `bounded` response is displayed as a partial search.
Hidden directories and symlinks are excluded. Terminal searches its active mounts; Dashboard searches
the selected workspace. This is content search, not semantic retrieval.

Document PUT, POST `document/move` and POST `document/delete` accept only private writable Markdown
content paths. All require the current SHA-256 before changing existing content, use the existing
workspace writer lock, and reject symlink traversal. A move never overwrites its destination. Moving
into `kg/entities/` validates frontmatter. Dashboard moves first call POST `document/move/preview` and
display a diff of each affected file. Confirmation sends `update_links: true` with `expected_plan`;
the server recomputes the plan under the writer lock and rejects stale source, backlinks or
destinations before publishing. Old clients may still request a plain move without link rewriting.

Link updates cover visible Markdown files in the same workspace: static Markdown inline/reference
links, images, wikilinks, literal `href` attributes and `@file:` references. Relative links inside the
moved document are rebased, and renamed title wikilinks become explicit path links while retaining
their display aliases. Code examples are preserved. Ambiguous title links and links in uneditable
files are listed for manual review; other workspaces and dynamic MDX expressions are not rewritten.
Preview fails rather than silently returning a partial plan for an oversized/unreadable corpus
(1,000 Markdown files / about 10 MB total / 500 KB per file). Individual writes are atomic and
ordinary failures roll back published backlinks. The destination is created before backlinks change,
and the old source is removed last; a process crash can leave both paths available for manual review.
Generated Wiki provenance is also recognized from frontmatter after a move. Save and commit affect
the selected path only; move/delete remain working-tree changes and never push a remote.

Meeting Q&A resolves aliased path wikilinks (including URL-encoded names and relative paths) in the
same visible workspace corpus as reviewed moves. Moved related documents remain selectable as
evidence. A document path is part of its citation identity, so older answers are still marked stale
when their cited document moves; asking again uses the new path. A saved answer's Wiki location is
discovered from `meeting_id` and `meeting_answer_id` frontmatter when the original path is absent.
Apply rechecks this location under the workspace lock and reuses it instead of recreating the old
path. Edited pages and ambiguous copies are preserved and return a conflict. Discovery excludes
hidden paths and symlinks and is bounded to 1,000 Markdown documents / 10 MB / 500 KB per file.

## Meeting evidence

The meeting question form can select up to four additional accessible meetings. The server checks
each meeting's authorization, namespaces its sources, and checks all cited evidence again after
generation and before Wiki Apply. Sources are ranked within each meeting and selected in rounds
across the meetings that have evidence, so a long first meeting cannot consume the entire budget.
Selection is still bounded to 40 excerpts / 48,000 characters;
the UI reports partial coverage. Source audio uses the source meeting, not the question's anchor
meeting. Deleted or revoked meetings redact old claims/quotes and mark that answer stale instead of
blocking the rest of the history.

Facts can be reviewed in Dashboard or Terminal. Reviews retain their original evidence fingerprint
and review revision; dirty drafts conflict with newer reviews rather than replacing them. Wiki
publication remains an explicit, create-only action and never edits the canonical transcript.

## Start brief chat

Start supplies an explicit meeting focus and an absolute destination in an active private writable
workspace. New briefs use `kg/entities/meeting/brief-<native-id>.md` for a known meeting series, or
`kg/entities/meeting/brief-row-<meeting-row-id>.md` for a plan without a meeting link. Prompt and reader
share this path convention. Existing legacy notes are reused in their original private mount, with
Vietnamese title normalization as a fallback. The reader checks active private mounts by slug, and
the document's Open action retains that slug. A private brief cannot start with only shared mounts
active. An inactive private workspace must be activated again for its brief to be visible.

Explicit prep actions require the chat listener's acceptance callback. A busy chat or missing handler
returns an actionable error instead of claiming that the brief is running. Acceptance means the UI
has submitted the turn; provider/network failures remain visible in chat. The agent is instructed to
read the file first and preserve user-authored text/frontmatter. The prep page displays the file only
after it exists, rather than assuming an agent response created it.

Both personal notes and the bound shared README refresh every 12 seconds while visible and on window
focus. Read failures appear separately from a genuine missing brief and preserve the last good
render. The shared brief continues to use the bound workspace README. Today recognizes stable row-ID
brief filenames and checks the active private mount set, matching the prep page.

Run the browser regression from `clients/terminal` with `node tests/brief-flow.browser.mjs`; it uses
Chrome, the real prep/chat UI and fixture API/SSE responses, not a live provider account.

## Automatic meeting summaries

The meeting writer records the SHA-256 of its own generated Markdown in
`.meeting-generated/<document-id>.sha256`. It only regenerates an existing document when its bytes
still match that marker, and checks the document again after inference while holding the workspace
writer lock. Documents edited by a person, including legacy documents without a marker, are kept and
the worker reports a conflict. Publication uses atomic replacement and commits only the meeting file.
The marker stays local to the workspace and is never included in the document commit.

## Verification

From the repository root:

```sh
core/agent/.venv/bin/python -m pytest core/agent/tests/test_workspace_documents.py core/agent/tests/test_meeting_knowledge.py core/agent/tests/test_meeting_postprocess_offline.py
```

From `clients/terminal`, run `npm test`. From `services/dashboard`, run `npm test` and
`node tests/workspace-editor.browser.mjs` (requires installed Chrome). The browser regression bundles
the real UI with fixture authentication and API responses; it does not claim production deployment
or a live LLM-provider test.
