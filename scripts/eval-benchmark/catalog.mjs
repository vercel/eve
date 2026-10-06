// Pins benchmark model ids to their AI Gateway catalog release, so a provider
// re-pointing an alias shows up as an identity break instead of a trend.

export const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

/**
 * @param {{ name: string, id: string }[]} models
 * @param {string} judge
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ name: string, id: string, release: string }[]>}
 */
export async function resolveModelReleases(models, judge, fetchImpl = fetch) {
  const response = await fetchImpl(AI_GATEWAY_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(
      `AI Gateway model catalog request failed (${response.status}); cannot pin model releases.`,
    );
  }
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error("AI Gateway returned an invalid model catalog.");
  const catalog = new Map(body.data.map((entry) => [entry?.id, entry]));

  if (!catalog.has(judge)) {
    throw new Error(
      `AI Gateway catalog has no judge model "${judge}" (e2e/benchmark.json "judge"). Update the id.`,
    );
  }
  return models.map(({ name, id }) => {
    const entry = catalog.get(id);
    if (entry === undefined) {
      throw new Error(
        `AI Gateway catalog has no model "${id}" (e2e/benchmark.json model "${name}"). Update the id or remove the entry.`,
      );
    }
    // `released` is the catalog's release date in Unix seconds.
    if (typeof entry.released !== "number" || !Number.isFinite(entry.released)) {
      throw new Error(
        `AI Gateway catalog entry "${id}" (e2e/benchmark.json model "${name}") has no release date to pin.`,
      );
    }
    return { name, id, release: new Date(entry.released * 1000).toISOString().slice(0, 10) };
  });
}
