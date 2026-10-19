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
  const routing = asRecord(value);
  if (routing === undefined) return undefined;
  const affinitySource = asRecord(routing.affinity);
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
    const value = source[key];
    if (typeof value === "string" && value.length > 0) picked[key] = value;
  }
  return Object.keys(picked).length === 0 ? undefined : picked;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
