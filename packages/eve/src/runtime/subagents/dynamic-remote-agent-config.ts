import {
  expectAgentToolExposure,
  expectBoolean,
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
  getOptionalStringRecordProperty,
} from "#internal/authored-module.js";
import type { HeadersValue } from "#client/types.js";
import type { OutboundAuthFn } from "#public/agents/auth.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import type { AgentToolExposure } from "#shared/agent-definition.js";

/** A dynamic remote agent as the session records it: JSON, without its credentials. */
export interface DynamicRemoteAgentConfig {
  readonly description: string;
  readonly forwardPrincipal?: boolean;
  readonly path: string;
  readonly tool?: AgentToolExposure;
  readonly url: string;
  /** It carries `auth` or `headers`, which are code: they're rendered from its record. */
  readonly credentials?: true;
}

/** A dynamic remote agent's `auth` and `headers`, which its `render` creates. */
export interface RemoteAgentCredentials {
  readonly auth?: OutboundAuthFn;
  readonly headers?: HeadersValue;
}

/** Normalizes what a dynamic subagent returned for a remote agent: its config, and credentials. */
export async function normalizeDynamicRemoteAgent(input: {
  readonly name: string;
  readonly value: unknown;
}): Promise<{
  readonly config: DynamicRemoteAgentConfig;
  readonly credentials?: RemoteAgentCredentials;
}> {
  const message = `Dynamic subagent "${input.name}" must return defineAgent(...), defineRemoteAgent(...), or null.`;
  const record = expectObjectRecord(input.value, message);
  expectOnlyKnownKeys(
    record,
    ["auth", "description", "forwardPrincipal", "headers", "kind", "path", "tool", "url"],
    message,
  );

  if (record.kind !== "remote") {
    throw new Error(message);
  }

  const url = await resolveUrl(record.url, message);
  const credentials: { auth?: OutboundAuthFn; headers?: HeadersValue } = {};
  if (record.auth !== undefined) {
    credentials.auth = expectFunction<OutboundAuthFn>(
      record.auth,
      `${message} "auth" must be a function.`,
    );
  }
  if (record.headers !== undefined) {
    credentials.headers =
      typeof record.headers === "function"
        ? (record.headers as HeadersValue)
        : getOptionalStringRecordProperty(
            record,
            "headers",
            `${message} "headers" must be an object of string values or a function.`,
          );
  }
  const hasCredentials = credentials.auth !== undefined || credentials.headers !== undefined;
  const config: {
    description: string;
    forwardPrincipal?: boolean;
    path: string;
    tool?: AgentToolExposure;
    url: string;
    credentials?: true;
  } = {
    description: expectString(record.description, message),
    path: record.path === undefined ? EVE_SESSION_ROUTE_PATH : expectString(record.path, message),
    url,
  };

  if (record.forwardPrincipal !== undefined) {
    config.forwardPrincipal = expectBoolean(record.forwardPrincipal, message);
  }
  if (record.tool !== undefined) {
    config.tool = expectAgentToolExposure(record.tool, message);
  }
  if (hasCredentials) config.credentials = true;

  return hasCredentials ? { config, credentials } : { config };
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
