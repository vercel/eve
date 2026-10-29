import { isObject, readNonEmptyString } from "#shared/guards.js";

/**
 * The session affinity report AI Gateway returns in `providerMetadata.gateway.routing`.
 *
 * Gateway documents that new `affinity.outcome` values may appear, so every
 * field stays an open string.
 */
export interface GatewayRouting {
  readonly clientSessionId?: string;
  readonly clientSessionIdSource?: string;
  readonly affinity?: {
    readonly displacedProvider?: string;
    readonly outcome?: string;
    readonly pinnedProvider?: string;
  };
}

/**
 * Reads the session affinity fields from an unknown-shaped
 * `providerMetadata.gateway.routing` value and drops every other key.
 */
export function readGatewayRouting(value: unknown): GatewayRouting | undefined {
  if (!isObject(value)) return undefined;
  const routing = value;
  const affinitySource = isObject(routing.affinity) ? routing.affinity : undefined;
  const affinity = pickStrings(affinitySource, [
    "displacedProvider",
    "outcome",
    "pinnedProvider",
  ] as const);
  const result: { -readonly [K in keyof GatewayRouting]: GatewayRouting[K] } = {
    ...pickStrings(routing, ["clientSessionId", "clientSessionIdSource"] as const),
  };
  if (affinity !== undefined) result.affinity = affinity;
  return Object.keys(result).length === 0 ? undefined : result;
}

function pickStrings<const K extends string>(
  source: Readonly<Record<string, unknown>> | undefined,
  keys: readonly K[],
): { [P in K]?: string } | undefined {
  if (source === undefined) return undefined;
  const picked: { [P in K]?: string } = {};
  for (const key of keys) {
    const value = readNonEmptyString(source[key]);
    if (value !== undefined) picked[key] = value;
  }
  return Object.keys(picked).length === 0 ? undefined : picked;
}
