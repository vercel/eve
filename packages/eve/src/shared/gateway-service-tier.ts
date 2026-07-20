/**
 * The AI Gateway service tier a model's `providerOptions` requests:
 * `standard` (no tier authored), the `priority` tier eve's Fast mode writes,
 * or any other authored `custom` tier value.
 */
export type GatewayServiceTierState =
  | { kind: "standard" }
  | { kind: "priority" }
  | { kind: "custom"; value: string };

/**
 * Reads `gateway.serviceTier` from an unknown-shaped `providerOptions` value
 * (compiled manifest or `/eve/v1/info` payload). Anything absent or malformed
 * reads as `standard`.
 */
export function readGatewayServiceTier(providerOptions: unknown): GatewayServiceTierState {
  if (
    providerOptions === null ||
    typeof providerOptions !== "object" ||
    Array.isArray(providerOptions)
  ) {
    return { kind: "standard" };
  }
  const gateway = (providerOptions as Record<string, unknown>).gateway;
  if (gateway === null || typeof gateway !== "object" || Array.isArray(gateway)) {
    return { kind: "standard" };
  }
  const value = (gateway as Record<string, unknown>).serviceTier;
  if (typeof value !== "string") return { kind: "standard" };
  return value === "priority" ? { kind: "priority" } : { kind: "custom", value };
}
