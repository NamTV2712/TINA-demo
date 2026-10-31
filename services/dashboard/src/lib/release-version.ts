/**
 * Single source of truth for "what version of TINA is this dashboard
 * build pairs with". Surfaced via <VersionChip /> in the header + sidebar.
 *
 * NEVER hardcoded. Values are derived at build time by
 * scripts/generate-release-version.js (runs in npm `prebuild` / `predev`
 * hooks) and written to release-version.generated.json. Sources, in
 * priority order:
 *
 *   1. NEXT_PUBLIC_TINA_OSS_VERSION / *_RELEASE_DATE env vars
 *      (CI / Docker build-arg override path)
 *   2. root VERSION
 *   3. deploy/helm/charts/tina/Chart.yaml `appVersion`
 *      — authoritative source for the OSS release this dashboard ships in
 *   4. Latest git tag matching `v\d+\.\d+\.\d+`
 *
 * If a CI/Docker env override disagrees with VERSION / Chart.yaml, the
 * generator throws — build fails loud rather than shipping a stale public
 * release identity.
 */

import generated from "./release-version.generated.json";

export const RELEASE = {
  version: generated.version,
  releaseDate: generated.releaseDate,
  generatedAt: generated.generatedAt,
  source: generated.source,
};
