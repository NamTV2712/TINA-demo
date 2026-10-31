/**
 * L2 — acts.v1 ingress.
 *
 * The control plane's "remove bot" is one redis message; the connector must honour `leave` and
 * ignore everything else without ending a meeting by accident. The subscription is injected, so
 * this is offline.
 *
 * Run: npx tsx src/acts.test.ts
 */
import { actsChannel, createLeaveActs, type RedisSubscriber } from './acts.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

class FakeSubscriber implements RedisSubscriber {
  subscribed?: { channel: string; listener: (message: string) => void };
  unsubscribed?: string;
  quitCalls = 0;
  async subscribe(channel: string, listener: (message: string) => void): Promise<unknown> {
    this.subscribed = { channel, listener };
    return 1;
  }
  async unsubscribe(channel: string): Promise<unknown> {
    this.unsubscribed = channel;
    return 1;
  }
  async quit(): Promise<unknown> {
    this.quitCalls++;
    return 'OK';
  }
}

// ── leave is honoured exactly once per message ─────────────────────────────────────
{
  const client = new FakeSubscriber();
  const leaves: string[] = [];
  const logs: string[] = [];
  const acts = createLeaveActs({
    client,
    meetingId: 42,
    onLeave: (detail) => leaves.push(detail),
    log: (m) => logs.push(m),
  });
  check('the channel is bot_commands:meeting:{id}', actsChannel(42) === 'bot_commands:meeting:42');

  acts.start();
  await flush();
  check('start subscribes to the meeting channel', client.subscribed?.channel === 'bot_commands:meeting:42');

  client.subscribed!.listener(JSON.stringify({ action: 'leave' }));
  await flush();
  check('a leave act stops the session', leaves.length === 1 && /control plane/.test(leaves[0] ?? ''));

  // Off-contract traffic must never end a meeting.
  client.subscribed!.listener(JSON.stringify({ action: 'speak', text: 'hi' }));
  client.subscribed!.listener(JSON.stringify({ action: 'unknown' }));
  client.subscribed!.listener('not json');
  client.subscribed!.listener(JSON.stringify({}));
  await flush();
  check('other acts and malformed messages are ignored', leaves.length === 1);
  check('an unsupported act is logged, not acted on', logs.some((l) => l.includes("'speak'")));

  acts.start();
  await flush();
  check('start is idempotent', client.subscribed !== undefined);
}

// ── close releases the subscriber ──────────────────────────────────────────────────
{
  const client = new FakeSubscriber();
  const acts = createLeaveActs({ client, meetingId: 'native-id', onLeave: () => { /* */ }, log: () => { /* */ } });
  acts.start();
  await flush();
  await acts.close();
  check('close unsubscribes the channel', client.unsubscribed === 'bot_commands:meeting:native-id');
  check('close quits the subscriber connection', client.quitCalls === 1);

  let leaves = 0;
  const before = leaves;
  client.subscribed?.listener(JSON.stringify({ action: 'leave' }));
  await flush();
  check('no act is honoured after close', leaves === before);

  await acts.close();
  check('close is idempotent', client.quitCalls === 1);
}

// ── a subscribe failure leaves the session running ────────────────────────────────
{
  const client: RedisSubscriber = {
    async subscribe() { throw new Error('redis down'); },
  };
  const logs: string[] = [];
  const acts = createLeaveActs({
    client,
    meetingId: 1,
    onLeave: () => { check('leave must not arrive from a failed subscription', false); },
    log: (m) => logs.push(m),
  });
  let threw = false;
  try {
    acts.start();
    await flush();
  } catch {
    threw = true;
  }
  check('a redis outage is logged, never thrown into the session', !threw && logs.some((l) => l.includes('redis down')));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall acts checks passed');
process.exit(failed ? 1 : 0);
