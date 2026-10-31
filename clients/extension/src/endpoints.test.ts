/**
 * Endpoint resolution — the "one build serves all deployments" unit test.
 * Proves each `deployment` preset maps to the right ingest/gateway, that an
 * explicit URL override always wins, and that unknown/missing values fall back
 * to the default preset. Pure: no chrome, no WebSocket.
 * Run: npx tsx src/endpoints.test.ts
 */
import {
  resolveEndpoints, normalizeDeployment, DEFAULT_DEPLOYMENT, DEPLOYMENT_PRESETS,
  dashboardOverride, resolveDashboardUrl,
} from './endpoints.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

// ── presets: each deployment → the expected ingest + gateway ──
{
  const d = resolveEndpoints({ deployment: 'desktop' });
  check('desktop → ingest ws://127.0.0.1:9099/ingest', d.ingestUrl === 'ws://127.0.0.1:9099/ingest', d.ingestUrl);
  check('desktop → gateway http://127.0.0.1:8056', d.gatewayUrl === 'http://127.0.0.1:8056', d.gatewayUrl);
  check('desktop → deployment echoed', d.deployment === 'desktop');
}
{
  const c = resolveEndpoints({ deployment: 'cloud' });
  check('cloud → ingest ws://127.0.0.1:8092/ingest', c.ingestUrl === 'ws://127.0.0.1:8092/ingest', c.ingestUrl);
  check('cloud → gateway http://127.0.0.1:8056', c.gatewayUrl === 'http://127.0.0.1:8056', c.gatewayUrl);
  check('cloud → deployment echoed', c.deployment === 'cloud');
}

// ── default: no deployment given → DEFAULT_DEPLOYMENT (desktop) ──
{
  const def = resolveEndpoints();
  check('no config → default is desktop', def.deployment === DEFAULT_DEPLOYMENT && def.deployment === 'desktop');
  check('no config → desktop ingest', def.ingestUrl === DEPLOYMENT_PRESETS.desktop.ingestUrl);
  check('no config → desktop gateway', def.gatewayUrl === DEPLOYMENT_PRESETS.desktop.gatewayUrl);
}

// ── unknown / legacy deployment value → falls back to the default preset ──
{
  const u = resolveEndpoints({ deployment: 'staging-prod-xyz' });
  check('unknown deployment → default desktop preset', u.deployment === 'desktop' && u.ingestUrl === 'ws://127.0.0.1:9099/ingest');
  check('normalizeDeployment(garbage) → desktop', normalizeDeployment('garbage') === 'desktop');
  check('normalizeDeployment(undefined) → desktop', normalizeDeployment(undefined) === 'desktop');
  check('normalizeDeployment("cloud") → cloud', normalizeDeployment('cloud') === 'cloud');
  check('normalizeDeployment("desktop") → desktop', normalizeDeployment('desktop') === 'desktop');
}

// ── explicit override ALWAYS wins (over either preset), per field ──
{
  // Override the ingest only on the cloud preset → gateway still the cloud preset.
  const o = resolveEndpoints({ deployment: 'cloud', ingestUrl: 'wss://prod.example.com/ingest' });
  check('explicit ingest overrides the preset', o.ingestUrl === 'wss://prod.example.com/ingest', o.ingestUrl);
  check('non-overridden gateway stays the cloud preset', o.gatewayUrl === 'http://127.0.0.1:8056', o.gatewayUrl);
}
{
  // Override both, on the desktop preset → both replaced.
  const o = resolveEndpoints({ deployment: 'desktop', ingestUrl: 'wss://a/ingest', gatewayUrl: 'https://b' });
  check('explicit ingest+gateway both win on desktop', o.ingestUrl === 'wss://a/ingest' && o.gatewayUrl === 'https://b');
}
{
  // An override with no deployment specified still wins over the default preset.
  const o = resolveEndpoints({ gatewayUrl: 'https://only-gateway' });
  check('override wins even with default deployment', o.gatewayUrl === 'https://only-gateway' && o.ingestUrl === 'ws://127.0.0.1:9099/ingest');
}

// ── empty / whitespace overrides are IGNORED (fall through to the preset) ──
{
  const e = resolveEndpoints({ deployment: 'cloud', ingestUrl: '', gatewayUrl: '   ' });
  check('empty override ignored → cloud preset ingest', e.ingestUrl === 'ws://127.0.0.1:8092/ingest', e.ingestUrl);
  check('whitespace override ignored → cloud preset gateway', e.gatewayUrl === 'http://127.0.0.1:8056', e.gatewayUrl);
}
{
  // A non-empty override with surrounding whitespace is trimmed, then wins.
  const t = resolveEndpoints({ ingestUrl: '  wss://trimmed/ingest  ' });
  check('whitespace-wrapped override is trimmed then wins', t.ingestUrl === 'wss://trimmed/ingest', t.ingestUrl);
}

{
  const meeting = { platform: 'google_meet', nativeMeetingId: 'room/name?x', meetingId: 7 };
  check('Desktop dashboard uses its own host', resolveDashboardUrl() === 'http://127.0.0.1:8056');
  check('Desktop meeting links use encoded journal identity, not cloud numeric id',
    resolveDashboardUrl({}, meeting) === 'http://127.0.0.1:8056/transcripts/google_meet/room%2Fname%3Fx/review');
  for (const dashboardUrl of ['http://127.0.0.1:3001', ' http://localhost:3001/ ']) {
    check('legacy Desktop default is cleared', dashboardOverride({ dashboardUrl }) === '');
    check('legacy Desktop default resolves to Desktop', resolveDashboardUrl({ dashboardUrl }) === 'http://127.0.0.1:8056');
  }
  check('custom Desktop gateway is followed', resolveDashboardUrl({ gatewayUrl: 'http://127.0.0.1:18056/' }) === 'http://127.0.0.1:18056');
  check('custom UI is preserved without unrelated local meeting id',
    resolveDashboardUrl({ dashboardUrl: 'http://127.0.0.1:13001/' }, meeting) === 'http://127.0.0.1:13001');
  check('cloud custom UI retains numeric meeting links',
    resolveDashboardUrl({ deployment: 'cloud', dashboardUrl: 'https://tina.example/app/' }, meeting) === 'https://tina.example/app/meetings/7');
  check('cloud former port is not migrated', dashboardOverride({ deployment: 'cloud', dashboardUrl: 'http://localhost:3001' }) === 'http://localhost:3001');
  let rejected = false;
  try { resolveDashboardUrl({ dashboardUrl: 'javascript:alert(1)' }); } catch { rejected = true; }
  check('non-HTTP dashboard URL is rejected', rejected);
}

if (failed) { console.error(`\n❌ endpoints: ${failed} check(s) FAILED.`); throw new Error(`${failed} failed`); }
console.log('\n✅ endpoints: one build serves all deployments — preset by deployment, explicit URL always overrides.');
