interface ExternalCredentialRequirement {
  readonly method?: string;
  readonly reference: string;
  readonly service: string;
  readonly subjectTypes: readonly ("app" | "user")[];
}

export interface VercelConnectMetadata {
  readonly connector: string;
  readonly requirement?: ExternalCredentialRequirement;
}

export function extractVercelConnectMetadata(value: unknown): VercelConnectMetadata | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { connector, requirement } = value as {
    readonly connector?: unknown;
    readonly requirement?: unknown;
  };
  if (typeof connector !== "string" || connector.length === 0) return undefined;
  const parsedRequirement = extractCredentialRequirement(requirement);
  return parsedRequirement === undefined
    ? { connector }
    : { connector, requirement: parsedRequirement };
}

function extractCredentialRequirement(value: unknown): ExternalCredentialRequirement | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { method, reference, service, subjectTypes } = value as {
    readonly method?: unknown;
    readonly reference?: unknown;
    readonly service?: unknown;
    readonly subjectTypes?: unknown;
  };
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    typeof service !== "string" ||
    service.length === 0 ||
    !Array.isArray(subjectTypes) ||
    subjectTypes.length === 0 ||
    !subjectTypes.every((subjectType) => subjectType === "app" || subjectType === "user") ||
    (method !== undefined && (typeof method !== "string" || method.length === 0))
  ) {
    return undefined;
  }
  const parsed: {
    method?: string;
    reference: string;
    service: string;
    subjectTypes: ("app" | "user")[];
  } = {
    reference,
    service,
    subjectTypes,
  };
  if (typeof method === "string") parsed.method = method;
  return parsed;
}
