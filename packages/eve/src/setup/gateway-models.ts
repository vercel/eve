import { captureVercel } from "#setup/primitives/index.js";

const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

/**
 * Fetches the set of AI Gateway model ids, for validating a `--model` before
 * scaffolding. Routed through the (required) Vercel CLI — equivalent to:
 *
 *   vercel curl https://ai-gateway.vercel.sh/v1/models -- --silent | jq -r '.data[].id'
 *
 * Returns `null` when the catalog is unreachable (no `vercel`, not logged in, or
 * a malformed response) — callers must not block creation on it.
 */
export async function fetchGatewayModelIds(cwd: string): Promise<Set<string> | null> {
  const result = await captureVercel(["curl", AI_GATEWAY_MODELS_URL, "--", "--silent"], { cwd });
  if (!result.ok) return null;
  try {
    const json = JSON.parse(result.stdout) as { data?: { id?: unknown }[] };
    if (!Array.isArray(json.data)) return null;
    const ids = json.data
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string");
    return new Set(ids);
  } catch {
    return null;
  }
}
