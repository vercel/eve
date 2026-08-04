import {
  expectBoolean,
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
  getOptionalStringRecordProperty,
} from "#internal/authored-module.js";
import type { OutboundAuthFn } from "#public/agents/auth.js";
import { EVE_SESSIONS_ROUTE_PATH } from "#protocol/routes.js";
import type { JsonObject } from "#shared/json.js";
import { serializeOutputSchema, type ToolSchemaSource } from "#shared/tool-schema.js";

export interface DynamicRemoteAgentConfig {
  readonly credentialsStepId?: string;
  readonly description: string;
  readonly forwardPrincipal?: boolean;
  readonly outputSchema?: JsonObject;
  readonly path: string;
  readonly url: string;
}

export async function normalizeDynamicRemoteAgentConfig(input: {
  readonly name: string;
  readonly value: unknown;
}): Promise<DynamicRemoteAgentConfig> {
  const message = `Dynamic subagent "${input.name}" must return defineAgent(...), defineRemoteAgent(...), or null.`;
  const record = expectObjectRecord(input.value, message);
  expectOnlyKnownKeys(
    record,
    ["auth", "description", "forwardPrincipal", "headers", "kind", "outputSchema", "path", "url"],
    message,
  );

  if (record.kind !== "remote") {
    throw new Error(message);
  }

  const url = await resolveUrl(record.url, message);
  const credentialsStepId = readCredentialsStepId(record);
  validateCredentials(record, message);
  if (
    (record.auth !== undefined || record.headers !== undefined) &&
    credentialsStepId === undefined
  ) {
    throw new Error(
      `${message} Dynamic remote auth and headers must be compiled by eve so credentials stay out of durable workflow state.`,
    );
  }
  const config: {
    credentialsStepId?: string;
    description: string;
    forwardPrincipal?: boolean;
    outputSchema?: JsonObject;
    path: string;
    url: string;
  } = {
    description: expectString(record.description, message),
    path: record.path === undefined ? EVE_SESSIONS_ROUTE_PATH : expectString(record.path, message),
    url,
  };

  if (credentialsStepId !== undefined) {
    config.credentialsStepId = credentialsStepId;
  }
  if (record.forwardPrincipal !== undefined) {
    config.forwardPrincipal = expectBoolean(record.forwardPrincipal, message);
  }
  if (record.outputSchema !== undefined) {
    config.outputSchema = serializeOutputSchema(record.outputSchema as ToolSchemaSource);
  }

  return config;
}

async function resolveUrl(value: unknown, message: string): Promise<string> {
  const url =
    typeof value === "function"
      ? await expectFunction<() => string | Promise<string>>(value, message)()
      : expectString(value, message);
  if (url.length === 0) {
    throw new Error(`${message} The "url" field must resolve to a non-empty string.`);
  }
  return url;
}

function validateCredentials(record: Record<string, unknown>, message: string): void {
  if (record.auth !== undefined) {
    expectFunction<OutboundAuthFn>(record.auth, message);
  }
  if (record.headers !== undefined && typeof record.headers !== "function") {
    getOptionalStringRecordProperty(record, "headers", message);
  }
}

function readCredentialsStepId(record: Record<string, unknown>): string | undefined {
  const resolver = record.__eveResolveRemoteAgentCredentials;
  if (typeof resolver !== "function") {
    return undefined;
  }
  const stepId = (resolver as { readonly stepId?: unknown }).stepId;
  return typeof stepId === "string" ? stepId : undefined;
}
