import {
  deref,
  type OpenApiParameter,
  type OpenApiRequestBody,
} from "#runtime/connections/openapi-schema.js";
import type { SecurityPlacement } from "#runtime/connections/openapi-security.js";
import { isObject } from "#shared/guards.js";

/** HTTP methods OpenAPI defines operations for. */
export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Internal descriptor for one resolved OpenAPI operation. */
export interface OpenApiOperation {
  readonly toolName: string;
  /** The document's `operationId`, when the operation declares one. */
  readonly operationId: string | undefined;
  readonly method: HttpMethod;
  readonly pathTemplate: string;
  readonly description: string;
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBody: OpenApiRequestBody | undefined;
  readonly inputSchema: Record<string, unknown>;
  /** The schema of the operation's result, when its success response declares a JSON schema. */
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly security: SecurityPlacement | undefined;
}

/**
 * The JSON schema of an operation's success response, unconverted: that of its first 2xx
 * response to declare one, or of its `default` response when it declares no 2xx response, since
 * `default` beside a 2xx response describes errors.
 */
export function successResponseSchema(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const { responses } = operation;
  if (!isObject(responses)) {
    return undefined;
  }
  const success = Object.keys(responses).filter((status) => /^2(\d\d|XX)$/iu.test(status));
  for (const status of success.length > 0 ? success : ["default"]) {
    const schema = jsonResponseSchema(document, responses[status]);
    if (schema !== undefined) {
      return schema;
    }
  }
  return undefined;
}

/**
 * An OpenAPI 3 response keeps its schema under `content`, by media type, and a Swagger 2.0
 * response holds it directly. Only a JSON body is parsed, so only its schema types the body.
 */
function jsonResponseSchema(
  document: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> | undefined {
  const response = isObject(raw) ? deref(document, raw) : undefined;
  if (!isObject(response)) {
    return undefined;
  }
  const media = isObject(response.content) ? response.content["application/json"] : response;
  return isObject(media) && isObject(media.schema) ? media.schema : undefined;
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
  const operationId = declaredOperationId(operation);
  if (operationId !== undefined) {
    const sanitized = sanitizeToolName(operationId);
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

/** The operation's `operationId`, when it declares a non-empty one. */
export function declaredOperationId(operation: Record<string, unknown>): string | undefined {
  return typeof operation.operationId === "string" && operation.operationId.length > 0
    ? operation.operationId
    : undefined;
}

const MAX_TOOL_NAME_LENGTH = 64;

/** Coerces an arbitrary string into a provider-legal tool name (`[a-zA-Z0-9_-]`, ≤64). */
function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, MAX_TOOL_NAME_LENGTH);
}

/** Disambiguates a tool name against names already used in the same connection. */
export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (used.has(candidate)) {
    const ending = `_${suffix}`;
    candidate = `${name.slice(0, MAX_TOOL_NAME_LENGTH - ending.length)}${ending}`;
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
