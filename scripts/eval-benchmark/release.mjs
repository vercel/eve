// Release backfills: the benchmark run against a published eve release (its
// `eve@<version>` tag: that release's eve, fixtures, and eval runner) instead
// of main, so trends reach back before the nightly benchmark existed. The
// harness (planning, probes, and record derivation) stays main's, so every
// record is derived under current metric definitions.

export const NPM_PACKUMENT_URL = "https://registry.npmjs.org/eve";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** First release whose `eve eval` has each flag the benchmark passes. */
const EVAL_FLAG_RELEASES = { keepState: "0.83.1" };

/** @param {string} version e.g. "0.61.0" */
export function releaseTag(version) {
  if (!VERSION.test(version))
    throw new Error(`Release "${version}" must be a published eve version such as 0.61.0.`);
  return `eve@${version}`;
}

/**
 * Optional `eve eval` flags this release supports. Without `--keep-state`
 * (before 0.83.1), a local-world leg keeps no Workflow data to probe, so its
 * `durability.*` metrics are unavailable.
 */
export function evalFlags(version) {
  return Object.fromEntries(
    Object.entries(EVAL_FLAG_RELEASES).map(([flag, since]) => [
      flag,
      compareVersions(version, since) >= 0,
    ]),
  );
}

/**
 * When npm published this release: the backfilled run's date, so it lines
 * up with the main commits benchmarked at the time.
 *
 * @param {string} version
 * @param {typeof fetch} [fetchImpl]
 */
export async function releasePublishedAt(version, fetchImpl = fetch) {
  const response = await fetchImpl(NPM_PACKUMENT_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error(
      `npm registry request failed (${response.status}); cannot date the eve ${version} backfill.`,
    );
  const publishedAt = (await response.json())?.time?.[version];
  if (typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt)))
    throw new Error(`npm has no publish time for eve ${version}; was it published?`);
  return new Date(publishedAt).toISOString();
}

function compareVersions(a, b) {
  const parse = (version) => {
    const match = VERSION.exec(version);
    if (match === null) throw new Error(`"${version}" is not an x.y.z version.`);
    return match.slice(1).map(Number);
  };
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
