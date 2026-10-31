"""Meeting-link → ``(platform, native_meeting_id)`` parsing — the server-side twin of the
terminal's ``clients/terminal/src/surfaces/meetingId.ts`` (same id formats, same platforms).

Used by ``POST /meetings`` / ``PATCH /meetings/{id}`` (a planned meeting created from a pasted
link) and by ``calendar_sync`` (extracting the joinable link out of an ICS event's LOCATION /
DESCRIPTION). Pure string logic — no I/O, no framework imports; the one config read is
``TINA_JITSI_HOSTS`` (P14, declared in config.v1.json), consulted per call so tests and
reloads see the live env.

Id formats (mirrors the dashboard join-form):
  * google_meet → ``abc-defg-hij``
  * zoom        → 9–11 digits
  * teams       → the ``19:meeting_…@thread.v2`` thread id, or the ``/meet/<id>`` short-link segment
  * jitsi       → the room name (the URL's path segment). Hosts: meet.jit.si and
                  ``TINA_JITSI_HOSTS``-declared deployments always; *jitsi* / meet-labelled
                  hosts on pasted links only. The room name is deployment-scoped, so the raw
                  URL rides alongside as ``meeting_url`` — never reconstructed from the id.
  * discord     → ``<guildId>:<channelId>`` from
                  ``https://discord.com/channels/<guild>/<channel>``. The pair IS the meeting
                  address (a voice channel), so unlike jitsi it reconstructs deterministically.
"""
from __future__ import annotations

import os
import re
from typing import Optional
from urllib.parse import unquote, urlparse

_GMEET_ID = re.compile(r"^[a-z]{3}-[a-z]{4}-[a-z]{3}$")
_ZOOM_ID = re.compile(r"\d{9,11}")
# The repeat is BOUNDED on purpose. Unbounded (`[^@%\s/]+@thread\.v2`) this pattern is scanned
# with `.search()` over caller-supplied text, so every start offset that fails at `@thread.v2`
# is retried at the next one — quadratic in the input length on a string an attacker chooses
# (CodeQL py/polynomial-redos). A Teams thread id is a fixed-shape base64ish blob well under
# 256 characters, so the cap costs nothing and makes the scan linear-bounded.
_TEAMS_THREAD = re.compile(r"19:meeting_[^@%\s/]{1,256}@thread\.v2", re.IGNORECASE)
_TEAMS_SHORT = re.compile(r"/meet/([^/?#]+)", re.IGNORECASE)
# A Jitsi room is the URL path's single segment; permissive by design (jitsi accepts nearly any
# room string) but excludes separators/whitespace so a mangled URL never yields a bogus room.
_JITSI_ROOM = re.compile(r"^[^/?#\s]+$")
# Zoom's own two join paths, on a host that does not say "zoom" — see the hosted-domain branch in
# ``parse_meeting_url``. Anchored and digit-exact so nothing else can match it.
_ZOOM_HOSTED_PATH = re.compile(r"^/(?:meeting|j)/(\d{10,11})/?$", re.IGNORECASE)
# Discord addresses a voice channel with two snowflakes: guild + channel, both 15–21 digits
# (the same bound the connector's own parser enforces, discord/src/config.ts). The native id is
# ``<guildId>:<channelId>`` — the connector's id shape — and the join URL is the exact inverse.
_DISCORD_SNOWFLAKE = re.compile(r"^\d{15,21}$")
_DISCORD_NATIVE = re.compile(r"^(\d{15,21}):(\d{15,21})$")
# The hosts Discord actually serves channel links from. Exact-host matched (see ``_host_is``):
# a look-alike ``discord.com.evil.example`` must never yield a meeting address.
_DISCORD_HOSTS = frozenset({
    "discord.com", "www.discord.com", "canary.discord.com", "ptb.discord.com",
    "discordapp.com", "www.discordapp.com",
})


def _host_is(host: str, domain: str) -> bool:
    """True when ``host`` IS ``domain`` or a subdomain of it — never a substring test.

    ``"teams.live.com" in host`` also accepts ``teams.live.com.evil.example`` (the attacker owns
    the registrable domain) and ``evil-teams.live.com``; the same hole exists for every hostname
    checked with ``in`` or a bare ``endswith``. CodeQL calls it incomplete URL substring
    sanitization, and the fix is to compare the parsed ``hostname`` exactly, allowing only an
    explicit dot-separated subdomain."""
    return host == domain or host.endswith("." + domain)


def _has_passcode_param(query: str) -> bool:
    """True when the query string carries a Zoom passcode under either spelling.

    Required by the hosted-domain branch: the passcode is what makes a bare `/meeting/<digits>`
    path recognizably a Zoom join link rather than an arbitrary numeric route."""
    from urllib.parse import parse_qs

    params = parse_qs(query or "")
    return bool((params.get("password") or [""])[0] or (params.get("pwd") or [""])[0])


def _configured_jitsi_hosts() -> set[str]:
    """Deployment-declared Jitsi hostnames (``TINA_JITSI_HOSTS``, comma-separated) — for
    self-hosted deployments whose hostname carries neither "jitsi" nor a "meet" label. A
    listed host is as explicit as meet.jit.si, so it is honoured in EVERY mode, including
    the calendar (ICS) free-text scan."""
    raw = os.getenv("TINA_JITSI_HOSTS", "")
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


def parse_discord_channel_url(raw: str) -> Optional[str]:
    """A Discord channel link → ``"<guildId>:<channelId>"``, or ``None``.

    Matches the host EXACTLY and the path shape exactly (``/channels/<guild>/<channel>``), never
    by substring: a look-alike host or a deeper path (``/channels/<guild>/<channel>/<message>``)
    is not an address this bot can join. ``/channels/@me/<id>`` is a DM, not a guild voice room,
    and fails the snowflake check. The bot token then joins the channel through the connector's
    voice session (``core/meetings/services/discord``).
    """
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if host not in _DISCORD_HOSTS:
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) != 3 or parts[0] != "channels":
        return None
    guild, channel = parts[1], parts[2]
    if not (_DISCORD_SNOWFLAKE.match(guild) and _DISCORD_SNOWFLAKE.match(channel)):
        return None
    return f"{guild}:{channel}"


def discord_channel_url(native_meeting_id: str) -> Optional[str]:
    """The canonical join URL for ``"<guildId>:<channelId>"``, or ``None`` for a malformed id.

    CONSTRUCTIBLE by design (unlike a jitsi room, whose deployment is not in the id): a Discord
    guild+channel pair names the one address the bot joins, so a spawn never needs the caller to
    paste the link back. Matches ``parse_discord_channel_url`` exactly — the round trip is the
    contract the connector re-checks at the seam.
    """
    m = _DISCORD_NATIVE.match((native_meeting_id or "").strip())
    if not m:
        return None
    return f"https://discord.com/channels/{m.group(1)}/{m.group(2)}"


def parse_meeting_url(raw: str, *, generic_hosts: bool = True) -> Optional[tuple[str, str]]:
    """Parse a pasted meeting URL (or bare id) → ``(platform, native_meeting_id)``, or ``None``
    when nothing valid can be extracted. Accepts the same inputs the terminal's
    ``parseMeetingInput`` accepts, so a link that validates client-side also validates here.

    ``generic_hosts`` widens jitsi inference to the self-hosted conventions (a host containing
    "jitsi", or a bare ``meet.*`` host) — right for a DELIBERATELY pasted link, too loose for the
    ICS free-text scan (``find_meeting_link`` passes False so a calendar full of arbitrary links
    never imports a non-meeting as a jitsi room)."""
    value = (raw or "").strip()
    if not value:
        return None

    # Bare Google Meet code, e.g. "abc-defg-hij"
    if _GMEET_ID.match(value.lower()):
        return ("google_meet", value.lower())

    # Bare Discord native id "<guildId>:<channelId>" — the same string the API stores, so a
    # caller holding an id can spawn without re-pasting the link. Digit-exact, so it can never
    # shadow a Teams thread id ("19:meeting_…@thread.v2").
    if _DISCORD_NATIVE.match(value):
        return ("discord", value)

    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if host:
        if _host_is(host, "meet.google.com"):
            code = next((p for p in reversed(parsed.path.split("/")) if p), "").lower()
            return ("google_meet", code) if _GMEET_ID.match(code) else None
        if host in _DISCORD_HOSTS:
            native = parse_discord_channel_url(value)
            return ("discord", native) if native else None
        # Deliberately a NAME heuristic, not a domain allowlist: it is what claims a vanity or
        # hosted Zoom front door whose hostname still says "zoom" (zoom-lfx.platform.
        # linuxfoundation.org), including in the ICS free-text scan where the path-shape branch
        # below is switched off. It is not a trust decision — the only thing taken from the URL
        # is a 9-11 digit meeting id — so it is not the substring-sanitization defect that the
        # exact-host checks around it fix.
        if "zoom" in host:
            m = _ZOOM_ID.search(parsed.path) or _ZOOM_ID.search(parsed.query)
            return ("zoom", m.group(0)) if m else None
        if _host_is(host, "teams.microsoft.com") or _host_is(host, "teams.live.com"):
            # Classic deep link carries the thread id (…/l/meetup-join/19:meeting_…@thread.v2).
            thread = _TEAMS_THREAD.search(unquote(value))
            if thread:
                return ("teams", thread.group(0))
            # New short meeting link: teams.microsoft.com/meet/<id>?p=<passcode>.
            short = _TEAMS_SHORT.search(parsed.path)
            if short:
                return ("teams", short.group(1))
            return None
        # Zoom under SOMEBODY ELSE'S hostname — the twin of the MCP link parser's hosted-domain
        # branch, and it must stay in step with it (the two parsers answer the same question on
        # two doors: this one for a pasted/ICS link, that one for `parse_meeting_link`). An
        # organisation can front its Zoom tenancy on its own domain, and the link then carries no
        # "zoom" anywhere — the Linux Foundation's is
        # zoom-lfx.platform.linuxfoundation.org/meeting/<id>?password=<uuid>.
        #
        # Matched on the PATH SHAPE (Zoom's own two join paths, a 10-11 digit id) AND a passcode
        # parameter, never on the hostname — the hostname is the part that was replaced. The
        # narrowness is the point: a site with a numeric path segment must not be read as a
        # meeting. Declared-Jitsi hosts are exempt, and `generic_hosts=False` (the ICS free-text
        # scan) skips this entirely for the reason that flag exists — an event description full of
        # arbitrary links must not import one as a meeting.
        if generic_hosts and host not in _configured_jitsi_hosts() and host != "meet.jit.si":
            hosted = _ZOOM_HOSTED_PATH.match(parsed.path)
            if hosted and _has_passcode_param(parsed.query):
                return ("zoom", hosted.group(1))
        # Jitsi: the canonical public deployment, plus (for a deliberately pasted link) the common
        # self-hosted conventions — a host containing "jitsi", or a bare ``meet.*`` host (jitsi's
        # own recommended naming). Known platforms are matched ABOVE, so this only fires for
        # unclaimed hosts. The room is the path's single segment, kept EXACTLY as it appears in
        # the URL (case + percent-encoding preserved) — the native id is embedded back into the
        # construct-URL template and the DELETE path param, so it must stay URL-safe; decoding
        # here would corrupt rooms with encoded characters. Callers keep the raw URL alongside
        # (``meeting_url``) so a self-hosted room joins on ITS deployment, not the template's.
        is_jitsi_host = (
            host == "meet.jit.si"
            or host in _configured_jitsi_hosts()     # deployment-declared (TINA_JITSI_HOSTS)
            # Naming HEURISTICS — pasted-link-only (a deliberate user action): a host naming
            # jitsi, or a "meet" hostname LABEL anywhere (meet.example.org, eu.meet.example.org —
            # jitsi's recommended naming, regionalized). Both are too loose for the ICS scan,
            # where an event description full of arbitrary links (jitsi.github.io docs, vendor
            # meet.* products) must not import as joinable rooms — there, only the explicit
            # hosts above count; TINA_JITSI_HOSTS is the opt-in.
            or (generic_hosts and ("jitsi" in host or "meet" in host.split(".")))
        )
        if is_jitsi_host:
            room = parsed.path.strip("/")
            if not room or not _JITSI_ROOM.match(room):
                return None
            # A jitsi room name is deployment-scoped, so the native id embeds the host for
            # every non-canonical deployment (room@host — jitsi's own XMPP identity shape).
            # A bare room would make meet.jit.si/daily and video.corp/daily collide on every
            # (platform, native_meeting_id) key: duplicate checks, calendar adoption, MCP
            # idempotency. meet.jit.si keeps the bare room (canonical, unambiguous).
            return ("jitsi", room if host == "meet.jit.si" else f"{room}@{host}")
        return None

    # Bare numeric id → assume Zoom
    if re.fullmatch(r"\d{9,11}", value):
        return ("zoom", value)

    return None


def find_meeting_link(text: str) -> Optional[tuple[str, str, str]]:
    """Scan free text (an ICS LOCATION/DESCRIPTION) for the FIRST recognizable meeting URL →
    ``(platform, native_meeting_id, url)``, or ``None``. Only http(s) URLs are considered."""
    if not text:
        return None
    for m in re.finditer(r"https?://[^\s<>\"']+", text):
        url = m.group(0).rstrip(").,;")
        # Free-text scan: hold jitsi to the explicit hosts (meet.jit.si + TINA_JITSI_HOSTS) —
        # a calendar description is full of arbitrary links, and the pasted-link naming
        # heuristics (*jitsi* / ``meet.*``) would misread them as rooms.
        parsed = parse_meeting_url(url, generic_hosts=False)
        if parsed:
            return (parsed[0], parsed[1], url)
    return None
