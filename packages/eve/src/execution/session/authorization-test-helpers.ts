import type { AgentDefinition } from "#public/definitions/agent.js";
import { expect } from "vitest";

import { filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ToolContext } from "#tools/definition.js";
import type {
  AuthorizationDefinition,
  ConnectionPrincipal,
  TokenResult,
} from "#shared/connection-types.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#tools/schema.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";

interface WeatherAuthRuntime {
  /** The input of each get_weather call that got its token and ran. */
  executions(): readonly { city: string }[];
  completeCalls(): number;
  completedPrincipals(): readonly ConnectionPrincipal[];
  runtime: Awaited<ReturnType<typeof createTestRuntime>>;
}

/**
 * A get_weather tool behind an interactive authorization: getToken always
 * requires sign-in, and completeAuthorization mints `weather-token` from the
 * `oauth-code` callback and rejects an `access_denied` one. Shared by the
 * callback-resume and challenge-stays-open owner tests.
 */
export async function createWeatherAuthRuntime(
  agentName: string,
  modules: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"] = [],
  options: {
    readonly definition?: AgentDefinition;
    /** The connection `get_forecast` signs in to; by default `get_weather`'s, so one sign-in serves both. */
    readonly forecastConnection?: string;
  } = {},
): Promise<WeatherAuthRuntime> {
  let completeCalls = 0;
  const completedPrincipals: ConnectionPrincipal[] = [];
  const executions: { city: string }[] = [];
  const weatherAuth = (connection: string): AuthorizationDefinition<{ nonce: string }> => ({
    principalType: "user",
    async getToken(): Promise<TokenResult> {
      throw new ConnectionAuthorizationRequiredError(connection);
    },
    async startAuthorization({ callbackUrl }) {
      return {
        challenge: {
          displayName: "Weather",
          instructions: "Sign in to continue.",
          url: `https://idp.example/authorize?callback=${encodeURIComponent(callbackUrl)}`,
        },
        resume: { nonce: "weather-nonce" },
      };
    },
    async completeAuthorization({ callback, principal, resume }): Promise<TokenResult> {
      completeCalls += 1;
      completedPrincipals.push(principal);
      if (callback.params.error === "access_denied") {
        throw new ConnectionAuthorizationFailedError(connection, {
          reason: "access_denied",
          retryable: false,
        });
      }
      expect(callback.params.code).toBe("oauth-code");
      expect(resume).toEqual({ nonce: "weather-nonce" });
      return { token: "weather-token" };
    },
  });
  const weatherTool = (name: string, connection: string): ResolvedToolDefinition => ({
    description: `${name} for a city.`,
    execute: createToolExecuteWithAuth({
      scope: name,
      async execute(rawInput, rawCtx) {
        const ctx = rawCtx as ToolContext;
        const token = await ctx.getToken(weatherAuth(connection), {
          authKey: connection,
          displayName: "Weather",
        });
        const city =
          typeof rawInput === "object" &&
          rawInput !== null &&
          typeof (rawInput as { city?: unknown }).city === "string"
            ? (rawInput as { city: string }).city
            : "Lisbon";
        executions.push({ city });
        return {
          city,
          condition: "Sunny",
          summary: `authorized with ${token.token}`,
          temperatureF: 72,
        };
      },
    }),
    inputSchema: toInputSchema({
      additionalProperties: false,
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
      type: "object",
    }),
    logicalPath: `tools/${name}.ts`,
    name,
    owner: { kind: "application" },
    sourceId: `tools/${name}.ts`,
    sourceKind: "module",
  });
  const tools = [
    weatherTool("get_weather", "weather"),
    weatherTool("get_forecast", options.forecastConnection ?? "weather"),
  ];
  const runtime = await createTestRuntime({
    agent: { name: agentName, definition: options.definition },
    modules,
    tools,
  });
  for (const tool of tools) {
    const manifestTool = runtime.manifest.tools.find((entry) => entry.name === tool.name);
    if (manifestTool === undefined) {
      throw new Error(`Expected ${tool.name} to be present in the test manifest.`);
    }
    runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
      default: {
        execute: tool.execute,
      },
    };
  }
  return {
    completeCalls: () => completeCalls,
    completedPrincipals: () => completedPrincipals,
    executions: () => executions,
    runtime,
  };
}

export function authorizationAttemptId(events: readonly UnstampedMessageStreamEvent[]): string {
  const required = filterEventsByType(events, "authorization.required")[0];
  const webhookUrl = required?.data.webhookUrl;
  if (webhookUrl === undefined) throw new Error("Missing authorization callback URL.");
  const segments = new URL(webhookUrl).pathname.split("/");
  const callbackIndex = segments.lastIndexOf("callback");
  const attemptId = segments[callbackIndex + 1];
  if (callbackIndex === -1 || attemptId === undefined) {
    throw new Error("Authorization callback URL is missing its attempt ID.");
  }
  return decodeURIComponent(attemptId);
}

export function userAuth(principalId: string) {
  return {
    attributes: {},
    authenticator: "test-idp",
    issuer: "test-idp",
    principalId,
    principalType: "user" as const,
  };
}

export async function startWeatherRun(
  continuationToken: string,
  message = "Use the get_weather tool to check the weather in Lisbon.",
) {
  return await startSessionOwner(workflowEntry, [
    {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message },
      serializedContext: buildSerializedContext({
        auth: userAuth("user-1"),
        channelKind: "http",
        continuationToken,
      }),
    },
  ]);
}

export function weatherCallback(attemptId: string, code = "oauth-code") {
  return {
    authorizationCallback: {
      attemptId,
      callback: { method: "GET", params: { code } },
      connectionName: "weather",
    },
  };
}
