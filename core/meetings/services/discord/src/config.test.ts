/**
 * L2 — connector configuration and Discord target resolution.
 *
 * The two invariants that keep a bot out of the wrong room:
 *   • a malformed invocation.v1 object is rejected against the PUBLISHED schema (by path), and
 *   • `nativeMeetingId` and `meetingUrl` must agree — a mismatch is refused, never resolved by
 *     preferring one of them.
 *
 * Run: npx tsx src/config.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError,
  InvocationError,
  loadConnectorConfig,
  loadInvocation,
  parseDiscordChannelUrl,
  parseInvocation,
  parseNativeDiscordId,
  resolveDiscordTarget,
  type Invocation,
} from './config.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

function throws(fn: () => unknown, want: new (...a: never[]) => Error, label: string): void {
  try {
    fn();
    check(label, false, 'did not throw');
  } catch (e) {
    check(label, e instanceof want, `${(e as Error)?.name}: ${(e as Error)?.message}`);
  }
}

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';

function invocation(over: Partial<Invocation> = {}): Invocation {
  return {
    platform: 'discord',
    meetingUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}`,
    nativeMeetingId: `${GUILD}:${CHANNEL}`,
    botName: 'TINA',
    redisUrl: 'redis://localhost:6379/0',
    connectionId: 'conn-1',
    meeting_id: 42,
    ...over,
  };
}

// ── invocation.v1 is validated against the sealed schema ────────────────────────────
{
  const inv = parseInvocation(invocation());
  check('a valid discord invocation parses', inv.platform === 'discord' && inv.botName === 'TINA');

  throws(
    () => parseInvocation({ ...invocation(), platform: 'myspace' }),
    InvocationError,
    'an unknown platform is rejected by sealed invocation.v1',
  );
  throws(
    () => parseInvocation({ ...invocation(), extra: 'nope' }),
    InvocationError,
    'unknown invocation fields are rejected (additionalProperties:false)',
  );
  throws(
    () => parseInvocation({ platform: 'discord', botName: 'TINA', redisUrl: 'redis://x' }),
    InvocationError,
    'missing meetingUrl is rejected',
  );
}

// ── loadInvocation: TINA_BOT_CONFIG is mandatory and must be for this platform ──────
{
  throws(() => loadInvocation({}), InvocationError, 'missing TINA_BOT_CONFIG fails fast');
  throws(() => loadInvocation({ TINA_BOT_CONFIG: '{not json' }), InvocationError, 'malformed JSON fails fast');
  throws(
    () => loadInvocation({ TINA_BOT_CONFIG: JSON.stringify(invocation({ platform: 'google_meet' })) }),
    InvocationError,
    'a google_meet invocation is refused by the Discord connector',
  );
  const loaded = loadInvocation({ TINA_BOT_CONFIG: JSON.stringify(invocation()) });
  check('a discord invocation loads from env', loaded.platform === 'discord');
}

// ── Discord channel URLs ────────────────────────────────────────────────────────────
{
  const url = parseDiscordChannelUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}`);
  check('canonical channel URL parses', url?.guildId === GUILD && url?.channelId === CHANNEL);

  const variants = [
    `https://www.discord.com/channels/${GUILD}/${CHANNEL}`,
    `https://canary.discord.com/channels/${GUILD}/${CHANNEL}`,
    `https://ptb.discord.com/channels/${GUILD}/${CHANNEL}/`,
    `https://discordapp.com/channels/${GUILD}/${CHANNEL}?foo=1`,
    `https://discord.com/channels/${GUILD}/${CHANNEL}#x`,
    `HTTPS://DISCORD.COM/channels/${GUILD}/${CHANNEL}`,
  ];
  check('app hosts, trailing slash, query, hash and case are accepted',
    variants.every((v) => parseDiscordChannelUrl(v)?.channelId === CHANNEL));

  const rejected = [
    'https://example.com/channels/111111111111111111/222222222222222222',
    `https://discord.com/channels/${GUILD}`,
    `https://discord.com/channels/${GUILD}/${CHANNEL}/messages/${CHANNEL}`,
    'https://discord.com/invite/abcdef',
    'not a url',
  ];
  check('guild-only, message links and foreign hosts are rejected',
    rejected.every((v) => parseDiscordChannelUrl(v) === null));
}

// ── native ids ──────────────────────────────────────────────────────────────────────
{
  check('native id accepts ":"', parseNativeDiscordId(`${GUILD}:${CHANNEL}`)?.channelId === CHANNEL);
  check('native id accepts "/"', parseNativeDiscordId(`${GUILD}/${CHANNEL}`)?.channelId === CHANNEL);
  check('native id rejects a non-snowflake', parseNativeDiscordId('123:abc') === null);
  check('native id rejects a channel-only id', parseNativeDiscordId(CHANNEL) === null);
}

// ── target resolution ───────────────────────────────────────────────────────────────
{
  const fromNative = resolveDiscordTarget(invocation({ meetingUrl: null }));
  check('nativeMeetingId alone resolves', fromNative.guildId === GUILD && fromNative.channelId === CHANNEL);

  const fromUrl = resolveDiscordTarget(invocation({ nativeMeetingId: undefined }));
  check('meetingUrl alone resolves', fromUrl.guildId === GUILD && fromUrl.channelId === CHANNEL);

  const other = '333333333333333333';
  throws(
    () => resolveDiscordTarget(invocation({ nativeMeetingId: `${GUILD}:${other}` })),
    InvocationError,
    'a native/URL mismatch is refused',
  );
  throws(
    () => resolveDiscordTarget(invocation({ nativeMeetingId: undefined, meetingUrl: null })),
    InvocationError,
    'no target at all is refused',
  );
  throws(
    () => resolveDiscordTarget(invocation({ nativeMeetingId: 'garbage', meetingUrl: null })),
    InvocationError,
    'a malformed native id is refused',
  );
}

// ── connector env ───────────────────────────────────────────────────────────────────
{
  throws(() => loadConnectorConfig({}), Error, 'DISCORD_BOT_TOKEN is required');

  const defaults = loadConnectorConfig({ DISCORD_BOT_TOKEN: ' bot-token ' });
  check('defaults: 8091, 4 sessions, 16 channels',
    defaults.port === 8091 && defaults.maxSessions === 4 && defaults.maxChannels === 16);
  check('token is trimmed', defaults.token === 'bot-token');
  check('no allowlist means every guild', defaults.guildAllowlist.size === 0);

  const tuned = loadConnectorConfig({
    DISCORD_BOT_TOKEN: 't',
    DISCORD_CONNECTOR_PORT: '9000',
    DISCORD_MAX_SESSIONS: '9',
    DISCORD_GUILD_ALLOWLIST: `${GUILD}, 444444444444444444`,
    DISCORD_MAX_CHANNELS: '8',
  });
  check('explicit values are honoured',
    tuned.port === 9000 && tuned.maxSessions === 9 && tuned.maxChannels === 8);
  check('allowlist is parsed and trimmed',
    tuned.guildAllowlist.has(GUILD) && tuned.guildAllowlist.has('444444444444444444'));

  throws(
    () => loadConnectorConfig({ DISCORD_BOT_TOKEN: 't', DISCORD_CONNECTOR_PORT: 'eighty' }),
    Error,
    'a non-numeric port fails fast',
  );
  throws(
    () => loadConnectorConfig({ DISCORD_BOT_TOKEN: 't', DISCORD_CONNECTOR_PORT: '70000' }),
    Error,
    'an out-of-range port fails fast',
  );
  throws(
    () => loadConnectorConfig({ DISCORD_BOT_TOKEN: 't', DISCORD_GUILD_ALLOWLIST: 'not-a-guild' }),
    Error,
    'a non-snowflake allowlist entry fails fast',
  );
}

const contracts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts', 'invocation.v1', 'invocation.schema.json');
check('the invocation schema is reachable from src/ by path', readFileSync(contracts, 'utf8').includes('Invocation'));

check('ContractError is the common base of InvocationError', new InvocationError('x') instanceof ContractError);

console.log(failed ? `\n${failed} check(s) failed` : '\nall config checks passed');
process.exit(failed ? 1 : 0);
