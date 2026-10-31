/**
 * Endpoint resolution — the "one build serves all deployments" piece.
 *
 * ONE extension build runs against every self-hosted TINA deployment (desktop, lite, compose,
 * helm). Rather than ship a build per target, the user picks a `deployment` preset
 * (or pastes explicit URLs) and this module resolves the concrete ingest +
 * gateway endpoints. Pure + dependency-free so it unit-tests without a browser
 * (see endpoints.test.ts).
 *
 * Resolution order (per field, independent):
 *   1. an explicit, non-empty URL from settings always wins (any deployment), then
 *   2. the chosen deployment preset's default.
 *
 *   - ingest  = the capture.v1 WebSocket (audio/events/recording).
 *   - gateway = the REST API base (bots list, meeting status, finalize on stop).
 *
 * Presets:
 *   - desktop : ws://127.0.0.1:9099/ingest  +  http://127.0.0.1:8056
 *               (the all-Node desktop pipeline — the default).
 *   - cloud   : ws://127.0.0.1:8092/ingest  +  http://127.0.0.1:8056
 *               (compose/helm/lite reached through a local port-forward/tunnel).
 */

export type Deployment = 'desktop' | 'cloud';

export const DEFAULT_DEPLOYMENT: Deployment = 'desktop';

export interface DeploymentPreset {
  ingestUrl: string;
  gatewayUrl: string;
}

/** Built-in presets, keyed by deployment. */
export const DEPLOYMENT_PRESETS: Record<Deployment, DeploymentPreset> = {
  desktop: { ingestUrl: 'ws://127.0.0.1:9099/ingest', gatewayUrl: 'http://127.0.0.1:8056' },
  cloud:   { ingestUrl: 'ws://127.0.0.1:8092/ingest', gatewayUrl: 'http://127.0.0.1:8056' },
};

/** Settings shape this resolver reads (a subset of the stored config). */
export interface EndpointConfig {
  /** Chosen preset; falls back to the default when missing/unknown. */
  deployment?: string;
  /** Explicit override for the ingest WebSocket (wins over the preset when non-empty). */
  ingestUrl?: string;
  /** Explicit override for the gateway REST base (wins over the preset when non-empty). */
  gatewayUrl?: string;
  dashboardUrl?: string;
}

export interface ResolvedEndpoints {
  deployment: Deployment;
  ingestUrl: string;
  gatewayUrl: string;
}

/** Normalize an arbitrary stored value to a known deployment (default otherwise). */
export function normalizeDeployment(value: unknown): Deployment {
  return value === 'cloud' || value === 'desktop' ? value : DEFAULT_DEPLOYMENT;
}

/**
 * Resolve the concrete ingest + gateway endpoints for a stored config.
 * Explicit non-empty URLs override the chosen preset; otherwise the preset wins.
 */
export function resolveEndpoints(cfg: EndpointConfig = {}): ResolvedEndpoints {
  const deployment = normalizeDeployment(cfg.deployment);
  const preset = DEPLOYMENT_PRESETS[deployment];
  const explicit = (v: string | undefined): string => (v && v.trim() ? v.trim() : '');
  return {
    deployment,
    ingestUrl: explicit(cfg.ingestUrl) || preset.ingestUrl,
    gatewayUrl: explicit(cfg.gatewayUrl) || preset.gatewayUrl,
  };
}

/** Retire the old Desktop dashboard default; Desktop meetings live in its own journal. */
export function dashboardOverride(cfg: EndpointConfig): string {
  const value = (cfg.dashboardUrl ?? '').trim().replace(/\/+$/, '');
  return normalizeDeployment(cfg.deployment) === 'desktop' && /^http:\/\/(127\.0\.0\.1|localhost):3001$/i.test(value) ? '' : value;
}

export function resolveDashboardUrl(cfg: EndpointConfig = {}, meeting?: {
  platform?: string | null; nativeMeetingId?: string | null; meetingId?: number | null;
}): string {
  const endpoints = resolveEndpoints(cfg);
  const gateway = endpoints.gatewayUrl.replace(/\/+$/, '');
  const base = dashboardOverride(cfg) || (endpoints.deployment === 'desktop' ? gateway : 'http://127.0.0.1:3001');
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid dashboard URL');
  if (endpoints.deployment === 'desktop' && base === gateway) {
    return meeting?.platform && meeting.nativeMeetingId
      ? `${base}/transcripts/${encodeURIComponent(meeting.platform)}/${encodeURIComponent(meeting.nativeMeetingId)}/review`
      : base;
  }
  // A custom cloud UI cannot resolve Desktop's local SQLite meeting ids.
  return endpoints.deployment === 'cloud' && meeting?.meetingId ? `${base}/meetings/${meeting.meetingId}` : base;
}
