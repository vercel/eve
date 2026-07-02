import type { McpClientConnectionDefinition } from "#public/definitions/connections/mcp.js";
import type { OpenAPIConnectionDefinition } from "#public/definitions/connections/openapi.js";
import type {
  ConnectionAuthDefinition,
  HeadersDefinition,
  ToolFilterDefinition,
} from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import { expectObjectRecord, expectOnlyKnownKeys } from "#internal/authored-module.js";

const KNOWN_TOP_LEVEL_KEYS = [
  "approval",
  "auth",
  "description",
  "headers",
  "tools",
  "url",
] as const;
const KNOWN_OPENAPI_TOP_LEVEL_KEYS = [
  "approval",
  "auth",
  "baseUrl",
  "description",
  "headers",
  "operations",
  "spec",
] as const;
const KNOWN_AUTHORIZATION_KEYS = [
  "completeAuthorization",
  "evict",
  "getToken",
  "principalType",
  "startAuthorization",
  // Optional metadata marker that auth-provider helpers may attach so
  // downstream tooling (eg. the eve compiler / Vercel dashboard) can
  // detect Vercel Connect-backed connections without opening the
  // closure state of `getToken`. The runtime never reads it; it
  // survives `normalizeAuthorizationSpec` so consumers can pick it
  // off the normalized auth definition. See
  // `runtime/connections/types.ts#AuthorizationDefinitionBase` for
  // the type and `@vercel/connect/eve`'s `connect()` for the
  // canonical producer.
  "vercelConnect",
] as const;

/**
 * Validates one authored MCP client connection module export at build time
 * and returns the public definition type. The module export is `unknown`
 * because it comes from a dynamically-loaded authored file; this function
 * bridges the gap with runtime checks so authoring errors surface during
 * `eve build`.
 */
export function normalizeMcpClientConnectionDefinition(
  value: unknown,
  message: string,
): McpClientConnectionDefinition {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, KNOWN_TOP_LEVEL_KEYS, message);

  validateUrl(record, message);
  validateDescription(record, message);

  const authorization = normalizeAuthorization(record, message);
  const headers = normalizeHeaders(record, message);
  const tools = normalizeToolFilter(record, message);

  if (authorization !== undefined && headers !== undefined && typeof headers !== "function") {
    const headerKeys = Object.keys(headers as Record<string, unknown>);
    if (headerKeys.some((k) => k.toLowerCase() === "authorization")) {
      throw new Error(
        `${message} "headers" must not include an "Authorization" key when "auth" is also provided.`,
      );
    }
  }

  const result: McpClientConnectionDefinition = {
    description: record.description as string,
    url: record.url as string,
  };

  if (authorization !== undefined) {
    result.auth = authorization;
  }
  if (headers !== undefined) {
    result.headers = headers;
  }
  if (tools !== undefined) {
    result.tools = tools;
  }

  if (record.approval !== undefined) {
    if (typeof record.approval !== "function") {
      throw new Error(`${message} The "approval" field must be a function when provided.`);
    }
    result.approval = record.approval as McpClientConnectionDefinition["approval"];
  }

  return result;
}

/**
 * Validates one authored OpenAPI connection module export at build time
 * and returns the public definition type. Mirrors
 * {@link normalizeMcpClientConnectionDefinition} but validates the
 * OpenAPI-specific `spec`/`baseUrl`/`operations` fields and reuses the
 * shared auth and headers validation.
 */
export function normalizeOpenApiConnectionDefinition(
  value: unknown,
  message: string,
): OpenAPIConnectionDefinition {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, KNOWN_OPENAPI_TOP_LEVEL_KEYS, message);

  validateSpec(record, message);
  validateBaseUrl(record, message);
  validateDescription(record, message);

  const authorization = normalizeAuthorization(record, message);
  const headers = normalizeHeaders(record, message);
  const operations = normalizeFilterField(record, "operations", message);

  if (authorization !== undefined && headers !== undefined && typeof headers !== "function") {
    const headerKeys = Object.keys(headers as Record<string, unknown>);
    if (headerKeys.some((k) => k.toLowerCase() === "authorization")) {
      throw new Error(
        `${message} "headers" must not include an "Authorization" key when "auth" is also provided.`,
      );
    }
  }

  const result: {
    -readonly [K in keyof OpenAPIConnectionDefinition]: OpenAPIConnectionDefinition[K];
  } = {
    description: record.description as string,
    spec: record.spec as OpenAPIConnectionDefinition["spec"],
  };

  if (record.baseUrl !== undefined) {
    result.baseUrl = record.baseUrl as string;
  }

  if (authorization !== undefined) {
    result.auth = authorization;
  }
  if (headers !== undefined) {
    result.headers = headers;
  }
  if (operations !== undefined) {
    result.operations = operations;
  }

  if (record.approval !== undefined) {
    if (typeof record.approval !== "function") {
      throw new Error(`${message} The "approval" field must be a function when provided.`);
    }
    result.approval = record.approval as OpenAPIConnectionDefinition["approval"];
  }

  return result;
}

function validateSpec(record: Record<string, unknown>, message: string): void {
  const spec = record.spec;
  if (typeof spec === "string") {
    if (!URL.canParse(spec)) {
      throw new Error(`${message} The "spec" field must be a valid URL when provided as a string.`);
    }
    const parsed = new URL(spec);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(
        `${message} The "spec" URL must use the http or https protocol, got "${parsed.protocol}".`,
      );
    }
    return;
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error(
      `${message} The "spec" field must be a URL string or an inline OpenAPI document object.`,
    );
  }
}

function validateBaseUrl(record: Record<string, unknown>, message: string): void {
  if (record.baseUrl === undefined) {
    return;
  }
  if (typeof record.baseUrl !== "string" || !URL.canParse(record.baseUrl)) {
    throw new Error(`${message} The "baseUrl" field must be a valid URL when provided.`);
  }

  const parsed = new URL(record.baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `${message} The "baseUrl" field must use the http or https protocol, got "${parsed.protocol}".`,
    );
  }
}

function validateUrl(record: Record<string, unknown>, message: string): void {
  if (typeof record.url !== "string" || !URL.canParse(record.url)) {
    throw new Error(`${message} The "url" field must be a valid URL.`);
  }

  const parsed = new URL(record.url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `${message} The "url" field must use the http or https protocol, got "${parsed.protocol}".`,
    );
  }
}

function validateDescription(record: Record<string, unknown>, message: string): void {
  if (typeof record.description !== "string" || record.description.length === 0) {
    throw new Error(`${message} The "description" field must be a non-empty string.`);
  }
}

function normalizeAuthorization(
  record: Record<string, unknown>,
  message: string,
): ConnectionAuthDefinition | undefined {
  if (record.auth === undefined) {
    return undefined;
  }

  if (typeof record.auth === "function") {
    return record.auth as ConnectionAuthDefinition;
  }

  const auth = expectObjectRecord(
    record.auth,
    `${message} The "auth" field must be an object with a "getToken" method or a function.`,
  );
  expectOnlyKnownKeys(auth, KNOWN_AUTHORIZATION_KEYS, `${message} The "auth" field`);

  return normalizeAuthorizationSpec(auth, message);
}

function normalizeHeaders(
  record: Record<string, unknown>,
  message: string,
): HeadersDefinition | undefined {
  if (record.headers === undefined) {
    return undefined;
  }

  if (typeof record.headers === "function") {
    return record.headers as HeadersDefinition;
  }

  if (
    typeof record.headers !== "object" ||
    record.headers === null ||
    Array.isArray(record.headers)
  ) {
    throw new Error(`${message} The "headers" field must be a plain object or a function.`);
  }

  const headersRecord = record.headers as Record<string, unknown>;

  for (const [key, val] of Object.entries(headersRecord)) {
    const valType = typeof val;
    if (valType !== "string" && valType !== "function" && valType !== "object") {
      throw new Error(
        `${message} The "headers.${key}" value must be a string, Promise, or function.`,
      );
    }
    if (
      valType === "object" &&
      (val === null || typeof (val as { then?: unknown }).then !== "function")
    ) {
      throw new Error(
        `${message} The "headers.${key}" value must be a string, Promise, or function.`,
      );
    }
  }

  return headersRecord as HeadersDefinition;
}

function normalizeToolFilter(
  record: Record<string, unknown>,
  message: string,
): ToolFilterDefinition | undefined {
  return normalizeFilterField(record, "tools", message);
}

/**
 * Validates an allow/block filter field (`tools` for MCP connections,
 * `operations` for OpenAPI connections). Both carry the same
 * {@link ToolFilterDefinition} shape — exactly one of `allow` or
 * `block`, each an array of strings.
 */
function normalizeFilterField(
  record: Record<string, unknown>,
  fieldName: "tools" | "operations",
  message: string,
): ToolFilterDefinition | undefined {
  const value = record[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${message} The "${fieldName}" field must specify either "allow" or "block".`);
  }

  const filterRecord = value as Record<string, unknown>;

  const hasAllow = "allow" in filterRecord;
  const hasBlock = "block" in filterRecord;

  if (hasAllow && hasBlock) {
    throw new Error(
      `${message} The "${fieldName}" field must specify either "allow" or "block", not both.`,
    );
  }

  if (!hasAllow && !hasBlock) {
    throw new Error(`${message} The "${fieldName}" field must specify either "allow" or "block".`);
  }

  if (hasAllow) {
    validateStringArray(filterRecord.allow, `${message} The "${fieldName}.allow"`);
    return { allow: filterRecord.allow as readonly string[] };
  }

  validateStringArray(filterRecord.block, `${message} The "${fieldName}.block"`);
  return { block: filterRecord.block as readonly string[] };
}

function validateStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label} field must be an array of strings.`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new Error(`${label}[${i}] must be a string.`);
    }
  }
}
