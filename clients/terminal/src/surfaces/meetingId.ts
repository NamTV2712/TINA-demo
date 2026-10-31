/** Meeting-link → {platform, native_meeting_id} parsing + validation for the "Add bot" flow.
 *  Id formats mirror the meeting-api parsers (collector/meeting_link.py):
 *    google_meet → abc-defg-hij   ·   zoom → 9–11 digits   ·   teams → non-empty (passcode handled elsewhere)
 *    jitsi → the meet.jit.si room name, or room@host for a self-hosted deployment (a single
 *    URL-safe path segment; declared TINA_JITSI_HOSTS arrive via the `jitsiHosts` parameter)
 *    discord → <guildId>:<channelId>, both 15–21 digit snowflakes (from /channels/<guild>/<channel>).
 *  Accepts either a raw id or a full meeting URL the user pasted. */

export type Platform = "google_meet" | "teams" | "zoom" | "jitsi" | "discord";

export interface ParsedMeeting {
  platform: Platform;
  native_meeting_id: string;
}

const GMEET_ID = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ZOOM_ID = /\d{9,11}/;
// A Jitsi room: one URL-safe path segment (no separators/whitespace) — the id is embedded
// back into the construct-URL template, so the encoded form is the id.
const JITSI_ROOM = /^[^/?#\s]+$/;
// Discord addresses a voice channel with two snowflakes; both are 10–21 digits in practice,
// bounded to 15–21 to match the connector's own parser exactly.
const DISCORD_SNOWFLAKE = /^\d{15,21}$/;
const DISCORD_NATIVE = /^(\d{15,21}):(\d{15,21})$/;
// The hosts Discord actually serves channel links from — EXACT host matching, never a substring
// test, so a look-alike (discord.com.evil.example) never yields a meeting address.
const DISCORD_HOSTS = new Set([
  "discord.com", "www.discord.com", "canary.discord.com", "ptb.discord.com",
  "discordapp.com", "www.discordapp.com",
]);

/** A Discord channel link → "<guildId>:<channelId>", or null. Path shape is exact: deeper
 *  permalinks (/channels/<guild>/<channel>/<message>) and DMs (/channels/@me/<id>) are not
 *  addresses this bot can join. */
function parseDiscordChannelUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!DISCORD_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "channels") return null;
  const [, guild, channel] = parts;
  if (!DISCORD_SNOWFLAKE.test(guild) || !DISCORD_SNOWFLAKE.test(channel)) return null;
  return `${guild}:${channel}`;
}

/** The canonical join link for a "<guildId>:<channelId>" native id, or null when malformed.
 *  CONSTRUCTIBLE (unlike a jitsi room): the pair names the one address the bot joins, so a
 *  pasted bare id still produces a `meeting_url` the API accepts. */
export function discordChannelUrl(nativeMeetingId: string): string | null {
  const m = DISCORD_NATIVE.exec(nativeMeetingId.trim());
  return m ? `https://discord.com/channels/${m[1]}/${m[2]}` : null;
}

/** Meet and Discord destinations are determined by the native id. Other platforms retain
 *  their original link because it carries deployment or passcode context. */
export function meetingUrlFor(parsed: { platform: string; native_meeting_id: string }, raw: string): string {
  if (parsed.platform === "google_meet") return `https://meet.google.com/${parsed.native_meeting_id}`;
  return parsed.platform === "discord" ? discordChannelUrl(parsed.native_meeting_id) ?? raw.trim() : raw.trim();
}

/** True if `id` is a valid native id for `platform`. */
export function isValidMeetingId(platform: Platform, id: string): boolean {
  const v = id.trim();
  if (!v) return false;
  if (platform === "google_meet") return GMEET_ID.test(v.toLowerCase());
  if (platform === "zoom") return /^\d{9,11}$/.test(v);
  if (platform === "jitsi") return JITSI_ROOM.test(v);
  if (platform === "discord") return DISCORD_NATIVE.test(v);
  return v.length > 0; // teams
}

/** Parse a pasted Google Meet / Teams / Zoom / Jitsi / Discord link (or bare id) into a platform +
 *  native id. Returns null when nothing valid can be extracted. `jitsiHosts` is the deployment's
 *  TINA_JITSI_HOSTS list (served by /api/meeting/jitsi-hosts) — declared hosts are recognized
 *  as jitsi even without jitsi/meet naming, matching the server parser. */
export function parseMeetingInput(raw: string, jitsiHosts: readonly string[] = []): ParsedMeeting | null {
  const input = raw.trim();
  if (!input) return null;

  // Bare Google Meet code, e.g. "abc-defg-hij"
  if (GMEET_ID.test(input.toLowerCase())) {
    return { platform: "google_meet", native_meeting_id: input.toLowerCase() };
  }

  // Bare Discord native id "<guildId>:<channelId>" — the same string the API stores, so an
  // operator holding an id can spawn without re-pasting the link. Digit-exact, so it can never
  // shadow a Teams thread id ("19:meeting_…@thread.v2").
  if (DISCORD_NATIVE.test(input)) {
    return { platform: "discord", native_meeting_id: input };
  }

  let url: URL | null = null;
  try {
    url = new URL(/^meet\.google\.com\//i.test(input) ? `https://${input}` : input);
  } catch {
    url = null;
  }

  if (url) {
    const host = url.hostname.toLowerCase();
    if (host === "meet.google.com") {
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return null;
      const code = url.pathname.match(/^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i)?.[1]?.toLowerCase() ?? "";
      return isValidMeetingId("google_meet", code) ? { platform: "google_meet", native_meeting_id: code } : null;
    }
    if (host.includes("meet.google.com")) return null;
    if (host.includes("zoom")) {
      const m = url.pathname.match(ZOOM_ID) || url.search.match(ZOOM_ID);
      return m ? { platform: "zoom", native_meeting_id: m[0] } : null;
    }
    if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) {
      // Classic deep link carries the thread id (…/l/meetup-join/19:meeting_…@thread.v2).
      const decoded = decodeURIComponent(input);
      const thread = decoded.match(/19:meeting_[^@%\s/]+@thread\.v2/i);
      if (thread) return { platform: "teams", native_meeting_id: thread[0] };
      // New short meeting link: teams.microsoft.com/meet/<id>?p=<passcode> — the native id is the path
      // segment; the passcode rides along in `meeting_url` (sent verbatim by the Add-bot call).
      const short = url.pathname.match(/\/meet\/([^/?#]+)/i);
      if (short) return { platform: "teams", native_meeting_id: short[1] };
      return null;
    }
    if (DISCORD_HOSTS.has(host)) {
      const native = parseDiscordChannelUrl(input);
      return native ? { platform: "discord", native_meeting_id: native } : null;
    }
    // Jitsi: LAST, so every known platform above claims its hosts first (mirrors the server
    // parser's ordering). The canonical public deployment, the deployment-declared hosts
    // (TINA_JITSI_HOSTS via `jitsiHosts` — same setting the server parser honours), plus the
    // common self-hosted conventions — a host containing "jitsi" (jitsi.example.org) or a
    // "meet" hostname LABEL anywhere (meet.example.org, eu.meet.example.org — jitsi's own
    // recommended naming, regionalized). The room is the path's single segment, kept exactly
    // as pasted (case + percent-encoding preserved — the raw URL rides along as meeting_url,
    // so the bot lands on the right deployment).
    const jitsiHost =
      host === "meet.jit.si" || jitsiHosts.includes(host) ||
      host.includes("jitsi") || host.split(".").includes("meet");
    if (jitsiHost) {
      const room = url.pathname.replace(/^\/+|\/+$/g, "");
      if (!room || !JITSI_ROOM.test(room)) return null;
      // A jitsi room is deployment-scoped: the native id embeds the host for every
      // non-canonical deployment (room@host — jitsi's own XMPP identity shape) so two
      // deployments' same-named rooms never share an identity key. Mirrors the server parser.
      return { platform: "jitsi", native_meeting_id: host === "meet.jit.si" ? room : `${room}@${host}` };
    }
    return null;
  }

  // Bare numeric id → assume Zoom
  if (/^\d{9,11}$/.test(input)) return { platform: "zoom", native_meeting_id: input };

  return null;
}
