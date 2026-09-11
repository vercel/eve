export interface VercelConnectMetadata {
  readonly connector: string;
  readonly connectorType?: string;
  readonly principalTypes?: readonly ("app" | "user")[];
}

export function extractVercelConnectMetadata(value: unknown): VercelConnectMetadata | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { connector, connectorType, principalTypes } = value as {
    readonly connector?: unknown;
    readonly connectorType?: unknown;
    readonly principalTypes?: unknown;
  };
  if (typeof connector !== "string" || connector.length === 0) return undefined;
  if (connectorType === undefined && principalTypes === undefined) return { connector };
  if (
    typeof connectorType !== "string" ||
    connectorType.length === 0 ||
    !Array.isArray(principalTypes) ||
    principalTypes.length === 0 ||
    !principalTypes.every((principalType) => principalType === "app" || principalType === "user")
  ) {
    return { connector };
  }
  return { connector, connectorType, principalTypes };
}
