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

## Codex research from Knowledge

Terminal and Dashboard chat offer an explicit **Nghiên cứu & lưu ghi chú** toggle. A document in
Terminal Knowledge also offers **Nghiên cứu & lưu**, addressing the selected file by its actual
active workspace path. `POST /api/chat` accepts optional `research: true`; the authenticated server
chooses an active private writable destination under `notes/research/<UTC-date>-<unique-id>.md`.
Without that private mount it refuses the request. Other files and canonical transcript/audio are
preserved. Ordinary chat and Start brief remain unchanged unless explicitly requested as research.
Research chat permits up to ten minutes for a request/reconnect, so multi-source work can survive
a delayed response; ordinary chat retains its existing timeout.

The agent is instructed to combine relevant mounted documents and authorized supplied meeting
context with public sources it actually inspects, read back the new note, and return its path.
The note contains a visible source table: `meeting | repo | web`, source name, direct link/file path,
evidence version and `verified_at`. Meeting rows distinguish transcript segments/revisions from
derived notes; repo rows identify workspace/file/commit and disclose local changes; web rows name
the page, direct URL and access date. Unknown versions and failed/partial research are explicit.
This is an agent workflow, not a deterministic fact-verification or extraction engine: users still
review claims and provenance. Private meeting/workspace content must not be sent to public search.

## Chat web citations

Successful `done.reply` is authoritative over streamed partial text in both clients. Codex web result
metadata resolves opaque citations only when an explicit reference-to-URL mapping exists. Actual
opened page URLs are listed separately as clickable sources; no mapping is inferred from search
order, query text or a single opened page. Titles fall back to host/path if absent. Missing mappings
display **Nguồn chưa có liên kết**, without exposing raw provider identifiers or inventing a link.
Existing Markdown links and code examples are preserved; unsafe link schemes/credentials are rejected.

Up to 50 source records per turn are saved alongside private Codex continuity in
`.codex/tina-sources/<thread>/<turn>.json`. History uses the matching recorded turn metadata and
opened URLs from the original rollout. Shared mounts never supply another user's chat sources.
Older rollouts can recover opened URLs, but cannot recover a reference mapping the provider never
returned. Dashboard keeps the selected authorized session in `agentSession` so reload restores its
history, including source links. Browser probes cover both clients with fixture SSE/history, and
the Dashboard probe checks the saved note's source-type/version/date table.

Run `node tests/agent-research.browser.mjs` from `services/dashboard`, and
`node tests/brief-flow.browser.mjs` from `clients/terminal` (installed Chrome required).

## Codex research permissions

Normal chat can use hosted live web search/open when granted both `WebSearch` and `WebFetch`;
search-only grants use cached results. Attached repositories remain local workspace context until
an explicit network tool reads a remote source. Shell network access additionally requires `Bash`
and the operator's managed domain allowlist, shipped with the worker image. The default shell
allowlist covers named GitHub hosts, not the whole internet; hosted search uses a separate provider
connection. Event/transcription turns stay read-only and offline. Model/account quotas can still
prevent research even when permissions are correct. See [the adapter policy](../core/agent/llm/README.md#codex-web-and-command-networking).

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
