import {
  deref,
  type OpenApiParameter,
  type OpenApiRequestBody,
} from "#runtime/connections/openapi-schema.js";
import type { SecurityPlacement } from "#runtime/connections/openapi-security.js";
import { isObject } from "#shared/guards.js";

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiOperation {
  readonly toolName: string;
  readonly operationId: string | undefined;
  readonly method: HttpMethod;
  readonly pathTemplate: string;
  readonly description: string;
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBody: OpenApiRequestBody | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly security: SecurityPlacement | undefined;
}

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
    const schema = jsonResponseSchema(document, operation, responses[status]);
    if (schema !== undefined) {
      return schema;
    }
  }
  return undefined;
}

function jsonResponseSchema(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> | undefined {
  const response = isObject(raw) ? deref(document, raw) : undefined;
  if (!isObject(response)) {
    return undefined;
  }
  if (isObject(response.content)) {
    const media = jsonContentEntry(response.content);
    return isObject(media) && isObject(media.schema) ? media.schema : undefined;
  }
  if (!swaggerProducesJson(document, operation)) {
    return undefined;
  }
  return isObject(response.schema) ? response.schema : undefined;
}

function jsonContentEntry(content: Record<string, unknown>): unknown {
  if ("application/json" in content) {
    return content["application/json"];
  }
  for (const [mediaType, entry] of Object.entries(content)) {
    if (isJsonMediaType(mediaType)) {
      return entry;
    }
  }
  return undefined;
}

function swaggerProducesJson(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
): boolean {
  const produces = Array.isArray(operation.produces)
    ? operation.produces
    : Array.isArray(document.produces)
      ? document.produces
      : undefined;
  if (produces === undefined || produces.length === 0) {
    return true;
  }
  return produces.some((mediaType) => typeof mediaType === "string" && isJsonMediaType(mediaType));
}

export function isJsonMediaType(mediaType: string): boolean {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

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

export function declaredOperationId(operation: Record<string, unknown>): string | undefined {
  return typeof operation.operationId === "string" && operation.operationId.length > 0
    ? operation.operationId
    : undefined;
}

const MAX_TOOL_NAME_LENGTH = 64;

function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, MAX_TOOL_NAME_LENGTH);
}

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

export function operationDescription(operation: Record<string, unknown>): string {
  if (typeof operation.summary === "string" && operation.summary.length > 0) {
    return operation.summary;
  }
  if (typeof operation.description === "string") {
    return operation.description;
  }
  return "";
}
