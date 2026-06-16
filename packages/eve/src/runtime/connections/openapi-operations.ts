import type { OpenApiParameter, OpenApiRequestBody } from "#runtime/connections/openapi-schema.js";
import type { SecurityPlacement } from "#runtime/connections/openapi-security.js";

/** HTTP methods OpenAPI defines operations for. */
export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Internal descriptor for one resolved OpenAPI operation. */
export interface OpenApiOperation {
  readonly toolName: string;
  readonly method: HttpMethod;
  readonly pathTemplate: string;
  readonly description: string;
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBody: OpenApiRequestBody | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly security: SecurityPlacement | undefined;
}

/**
 * Derives a tool name for an operation that is legal for model providers.
 *
 * Provider tool-name rules (Anthropic, OpenAI) only permit
 * `[a-zA-Z0-9_-]`, so an `operationId` is sanitized rather than used
 * verbatim — characters like dots or slashes (common in real specs)
 * would otherwise be rejected and break the whole connection. Operations
 * without an `operationId` get a deterministic `<method>_<path>` name.
 */
export function operationName(
  operation: Record<string, unknown>,
  method: HttpMethod,
  pathTemplate: string,
): string {
  if (typeof operation.operationId === "string" && operation.operationId.length > 0) {
    const sanitized = sanitizeToolName(operation.operationId);
    if (sanitized.length > 0) {
      return sanitized;
    }
  }
  const sanitizedPath = pathTemplate
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitizeToolName(`${method}_${sanitizedPath}`);
}

/** Coerces an arbitrary string into a provider-legal tool name (`[a-zA-Z0-9_-]`, ≤64). */
function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 64);
}

/** Disambiguates a tool name against names already used in the same connection. */
export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${name}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Picks a human description for an operation, preferring `summary` over `description`. */
export function operationDescription(operation: Record<string, unknown>): string {
  if (typeof operation.summary === "string" && operation.summary.length > 0) {
    return operation.summary;
  }
  if (typeof operation.description === "string") {
    return operation.description;
  }
  return "";
}
