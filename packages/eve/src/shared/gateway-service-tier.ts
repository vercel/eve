type GatewayServiceTierState =
  | { kind: "standard" }
  | { kind: "priority" }
  | { kind: "custom"; value: string };

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
