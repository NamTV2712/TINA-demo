import { describe, expect, it } from "vitest";
import { discordChannelUrl, isValidMeetingId, meetingUrlFor, parseMeetingInput } from "../meetingId";

describe("isValidMeetingId", () => {
  it("accepts a well-formed Google Meet code, rejects malformed", () => {
    expect(isValidMeetingId("google_meet", "abc-defg-hij")).toBe(true);
    expect(isValidMeetingId("google_meet", "ABC-DEFG-HIJ")).toBe(true); // case-insensitive
    expect(isValidMeetingId("google_meet", "abc-def-hij")).toBe(false);
    expect(isValidMeetingId("google_meet", "abcdefghij")).toBe(false);
    expect(isValidMeetingId("google_meet", "")).toBe(false);
  });

  it("accepts 9-11 digit Zoom ids only", () => {
    expect(isValidMeetingId("zoom", "123456789")).toBe(true);
    expect(isValidMeetingId("zoom", "12345678901")).toBe(true);
    expect(isValidMeetingId("zoom", "12345")).toBe(false);
    expect(isValidMeetingId("zoom", "abc")).toBe(false);
  });

  it("accepts any non-empty Teams id", () => {
    expect(isValidMeetingId("teams", "19:meeting_xyz@thread.v2")).toBe(true);
    expect(isValidMeetingId("teams", "")).toBe(false);
  });

  it("accepts a single URL-safe Jitsi room, rejects separators/whitespace", () => {
    expect(isValidMeetingId("jitsi", "TinaStandup")).toBe(true);
    expect(isValidMeetingId("jitsi", "Team%20Sync")).toBe(true); // encoded form IS the id
    expect(isValidMeetingId("jitsi", "a/b")).toBe(false);
    expect(isValidMeetingId("jitsi", "has space")).toBe(false);
    expect(isValidMeetingId("jitsi", "")).toBe(false);
  });

  it("accepts a Discord guild+channel snowflake pair only", () => {
    expect(isValidMeetingId("discord", "123456789012345678:987654321098765432")).toBe(true);
    // Bare snowflakes, one-sided pairs, short ids and separators are not addresses.
    expect(isValidMeetingId("discord", "123456789012345678")).toBe(false);
    expect(isValidMeetingId("discord", "123456789012345678:")).toBe(false);
    expect(isValidMeetingId("discord", "123:456")).toBe(false);
    expect(isValidMeetingId("discord", "123456789012345678/987654321098765432")).toBe(false);
    expect(isValidMeetingId("discord", "")).toBe(false);
  });
});

describe("parseMeetingInput", () => {
  it("accepts a scheme-less Meet link and rejects look-alike hosts", () => {
    expect(parseMeetingInput("meet.google.com/abc-defg-hij?authuser=1")).toEqual({ platform: "google_meet", native_meeting_id: "abc-defg-hij" });
    expect(parseMeetingInput("https://meet.google.com.evil.example/abc-defg-hij")).toBeNull();
  });

  it("builds the same Google Meet destination as the Dashboard native-id flow", () => {
    const parsed = { platform: "google_meet" as const, native_meeting_id: "abc-defg-hij" };
    for (const raw of ["abc-defg-hij", "https://meet.google.com/abc-defg-hij?authuser=1", "https://meet.google.com/meet/abc-defg-hij?hs=122"]) {
      expect(meetingUrlFor(parsed, raw)).toBe("https://meet.google.com/abc-defg-hij");
    }
  });
  it("parses a bare Google Meet code", () => {
    expect(parseMeetingInput("abc-defg-hij")).toEqual({ platform: "google_meet", native_meeting_id: "abc-defg-hij" });
  });

  it("parses a Google Meet URL", () => {
    expect(parseMeetingInput("https://meet.google.com/abc-defg-hij")).toEqual({
      platform: "google_meet",
      native_meeting_id: "abc-defg-hij",
    });
  });

  it("parses a Zoom URL and a bare zoom id", () => {
    expect(parseMeetingInput("https://us02web.zoom.us/j/12345678901")).toEqual({
      platform: "zoom",
      native_meeting_id: "12345678901",
    });
    expect(parseMeetingInput("1234567890")).toEqual({ platform: "zoom", native_meeting_id: "1234567890" });
  });

  it("parses a Teams meeting thread id from a URL", () => {
    const url =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123%40thread.v2/0";
    expect(parseMeetingInput(url)).toEqual({
      platform: "teams",
      native_meeting_id: "19:meeting_abc123@thread.v2",
    });
  });

  it("parses the new short Teams meeting link (teams.microsoft.com/meet/<id>?p=…)", () => {
    expect(parseMeetingInput("https://teams.microsoft.com/meet/33832851446746?p=Y16HhbYoEs9At3lGtb")).toEqual({
      platform: "teams",
      native_meeting_id: "33832851446746",
    });
  });

  it("parses a meet.jit.si room URL (case + encoding preserved)", () => {
    expect(parseMeetingInput("https://meet.jit.si/TinaStandup")).toEqual({
      platform: "jitsi",
      native_meeting_id: "TinaStandup",
    });
    expect(parseMeetingInput("https://meet.jit.si/Team%20Sync/")).toEqual({
      platform: "jitsi",
      native_meeting_id: "Team%20Sync",
    });
  });

  it("infers jitsi for self-hosted conventions (*jitsi* hosts, and a 'meet' host label)", () => {
    // Non-canonical deployments get a deployment-scoped id (room@host) — same-named rooms
    // on different hosts never share an identity key. Mirrors the server parsers.
    expect(parseMeetingInput("https://jitsi.example.org/MyRoom")).toEqual({
      platform: "jitsi",
      native_meeting_id: "MyRoom@jitsi.example.org",
    });
    expect(parseMeetingInput("https://meet.example.org/TeamSync")).toEqual({
      platform: "jitsi",
      native_meeting_id: "TeamSync@meet.example.org",
    });
    // Regionalized deployments put "meet" mid-hostname (eu.meet.example.org).
    expect(parseMeetingInput("https://eu.meet.example.org/QualifiedRoomName")).toEqual({
      platform: "jitsi",
      native_meeting_id: "QualifiedRoomName@eu.meet.example.org",
    });
    // "meet" must be a whole label — meetings.example.org is NOT a jitsi convention.
    expect(parseMeetingInput("https://meetings.example.org/Room")).toBeNull();
    // meet.google.com is claimed by the Meet rule above — never captured by the fallback.
    expect(parseMeetingInput("https://meet.google.com/abc-defg-hij")?.platform).toBe("google_meet");
  });

  it("recognizes TINA_JITSI_HOSTS-declared hosts via the jitsiHosts parameter", () => {
    // Without the declared list, a host with no jitsi/meet naming is rejected…
    expect(parseMeetingInput("https://calls.example.io/Standup")).toBeNull();
    // …with it, the link parses exactly like it does server-side.
    expect(parseMeetingInput("https://calls.example.io/Standup", ["calls.example.io"])).toEqual({
      platform: "jitsi",
      native_meeting_id: "Standup@calls.example.io",
    });
  });

  it("does not infer jitsi for a bare origin or a multi-segment path", () => {
    expect(parseMeetingInput("https://meet.jit.si/")).toBeNull();
    expect(parseMeetingInput("https://jitsi.example.org/a/b")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseMeetingInput("")).toBeNull();
    expect(parseMeetingInput("not a meeting")).toBeNull();
    expect(parseMeetingInput("https://example.com/whatever")).toBeNull();
  });

  it("parses a Discord channel link and a bare guild:channel id", () => {
    const guild = "123456789012345678";
    const channel = "987654321098765432";
    for (const host of ["discord.com", "www.discord.com", "canary.discord.com", "ptb.discord.com", "discordapp.com"]) {
      expect(parseMeetingInput(`https://${host}/channels/${guild}/${channel}`)).toEqual({
        platform: "discord",
        native_meeting_id: `${guild}:${channel}`,
      });
    }
    expect(parseMeetingInput(`${guild}:${channel}`)).toEqual({
      platform: "discord",
      native_meeting_id: `${guild}:${channel}`,
    });
  });

  it("refuses Discord lookalikes, DMs and message permalinks", () => {
    const guild = "123456789012345678";
    const channel = "987654321098765432";
    // A look-alike host is never Discord — exact host match, not a substring.
    expect(parseMeetingInput(`https://discord.com.evil.example/channels/${guild}/${channel}`)).toBeNull();
    expect(parseMeetingInput(`https://evil-discord.com/channels/${guild}/${channel}`)).toBeNull();
    // DMs have no guild; a message permalink is deeper than the channel route.
    expect(parseMeetingInput(`https://discord.com/channels/@me/${channel}`)).toBeNull();
    expect(parseMeetingInput(`https://discord.com/channels/${guild}/${channel}/999`)).toBeNull();
    // Discord links must not be read as Jitsi rooms via the "meet"-label fallback.
    expect(parseMeetingInput(`https://discord.com/${guild}`)).toBeNull();
  });

  it("keeps a Teams thread id distinct from a Discord native id", () => {
    expect(parseMeetingInput("19:meeting_abc123@thread.v2")).toBeNull();
  });

  it("constructs Discord's canonical link from the native id (and only for a valid pair)", () => {
    const guild = "123456789012345678";
    const channel = "987654321098765432";
    expect(discordChannelUrl(`${guild}:${channel}`)).toBe(`https://discord.com/channels/${guild}/${channel}`);
    expect(discordChannelUrl(`https://discord.com/channels/${guild}/${channel}`)).toBeNull();
    expect(discordChannelUrl("123:456")).toBeNull();
  });

  it("meetingUrlFor sends a constructible Discord link for a bare id, and the pasted text otherwise", () => {
    const guild = "123456789012345678";
    const channel = "987654321098765432";
    const native = `${guild}:${channel}`;
    const link = `https://discord.com/channels/${guild}/${channel}`;
    // A bare "guild:channel" is an id, not a URL the API accepts as meeting_url.
    expect(meetingUrlFor({ platform: "discord", native_meeting_id: native }, native)).toBe(link);
    expect(meetingUrlFor({ platform: "discord", native_meeting_id: native }, ` https://discordapp.com/channels/${guild}/${channel} `)).toBe(link);
    // Everything else forwards the pasted text verbatim (deployment/passcode context lives there).
    const zoom = "https://us02web.zoom.us/j/12345678901?pwd=x";
    expect(meetingUrlFor({ platform: "zoom", native_meeting_id: "12345678901" }, zoom)).toBe(zoom);
  });
});
