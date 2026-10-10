import {
  expectAgentToolExposure,
  expectBoolean,
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
} from "#internal/authored-module.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import type { AgentToolExposure } from "#shared/agent-definition.js";

export interface DynamicRemoteAgentConfig {
  readonly description: string;
  readonly forwardPrincipal?: boolean;
  readonly path: string;
  readonly tool?: AgentToolExposure;
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
    ["auth", "description", "forwardPrincipal", "headers", "kind", "path", "tool", "url"],
    message,
  );

  if (record.kind !== "remote") {
    throw new Error(message);
  }

  const url = await resolveUrl(record.url, message);
  if (record.auth !== undefined || record.headers !== undefined) {
    throw new Error(
      `${message} A dynamic remote agent can't carry auth or headers; define a static remote agent for authenticated upstreams.`,
    );
  }
  const config: {
    description: string;
    forwardPrincipal?: boolean;
    path: string;
    tool?: AgentToolExposure;
    url: string;
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
