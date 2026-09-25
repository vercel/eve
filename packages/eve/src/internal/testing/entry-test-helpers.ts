import { expect, vi } from "vitest";
import { getWorld } from "#internal/workflow/runtime.js";
import { hydrateWorkflowArguments, hydrateStepReturnValue } from "@workflow/core/serialization";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { type ToolContext } from "#tools/definition.js";
import type {
  AuthorizationDefinition,
  ConnectionPrincipal,
  TokenResult,
} from "#shared/connection-types.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#tools/schema.js";
import { ConversationContextKey } from "#shared/conversation-context.js";

export function buildSerializedContext(overrides: {
  acceptedDeploymentId?: string;
  audience?: "public" | "private" | "unknown";
  auth?: Record<string, unknown>;
  channelKind: string;
  channelState?: Record<string, unknown>;
  continuationToken?: string;
  mode: string;
  parent?: {
    readonly callId: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly turn: {
      readonly id: string;
      readonly sequence: number;
    };
  };
}): Record<string, unknown> {
  const channel: { kind: unknown; state: unknown } = {
    kind: overrides.channelKind,
    state: overrides.channelState ?? {},
  };
  const context: Record<string, unknown> = {
    "eve.auth": overrides.auth ?? null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": channel,
    "eve.mode": overrides.mode,
  };
  if (overrides.audience !== undefined) {
    context[ConversationContextKey.name] = {
      audience: overrides.audience,
      channel: { kind: overrides.channelKind },
      environment: "production",
      mode: overrides.mode,
      principalType: "anonymous",
    };
  }
  if (overrides.acceptedDeploymentId !== undefined) {
    context["eve.channelDelivery"] = {
      acceptedDeploymentId: overrides.acceptedDeploymentId,
      channelKind: overrides.channelKind,
      channelName: "test",
      deliveryId: "delivery-initial",
    };
  }
  if (overrides.continuationToken !== undefined) {
    context["eve.continuationToken"] = overrides.continuationToken;
  }
  if (overrides.parent !== undefined) {
    context["eve.parentSession"] = overrides.parent;
  }
  return context;
}

export interface WeatherAuthRuntime {
  completeCalls(): number;
  completedPrincipals(): readonly ConnectionPrincipal[];
  runtime: Awaited<ReturnType<typeof createTestRuntime>>;
}

/**
 * A get_weather tool behind an interactive authorization: getToken always
 * requires sign-in, and completeAuthorization mints `weather-token` from the
 * `oauth-code` callback. Shared by the callback-resume and
 * challenge-stays-open owner tests.
 */
export async function createWeatherAuthRuntime(agentName: string): Promise<WeatherAuthRuntime> {
  let completeCalls = 0;
  const completedPrincipals: ConnectionPrincipal[] = [];
  const weatherAuth: AuthorizationDefinition<{ nonce: string }> = {
    principalType: "user",
    async getToken(): Promise<TokenResult> {
      throw new ConnectionAuthorizationRequiredError("weather");
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
      expect(callback.params.code).toBe("oauth-code");
      expect(resume).toEqual({ nonce: "weather-nonce" });
      return { token: "weather-token" };
    },
  };
  const getWeatherTool: ResolvedToolDefinition = {
    description: "Get the current weather for a city.",
    execute: createToolExecuteWithAuth({
      scope: "get_weather",
      async execute(rawInput, rawCtx) {
        const ctx = rawCtx as ToolContext;
        const token = await ctx.getToken(weatherAuth, {
          authKey: "weather",
          displayName: "Weather",
        });
        const city =
          typeof rawInput === "object" &&
          rawInput !== null &&
          typeof (rawInput as { city?: unknown }).city === "string"
            ? (rawInput as { city: string }).city
            : "Lisbon";
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
    logicalPath: "tools/get_weather.ts",
    name: "get_weather",
    owner: { kind: "application" },
    sourceId: "tools/get_weather.ts",
    sourceKind: "module",
  };
  const runtime = await createTestRuntime({
    agent: { name: agentName },
    tools: [getWeatherTool],
  });
  const manifestTool = runtime.manifest.tools.find((tool) => tool.name === getWeatherTool.name);
  if (manifestTool === undefined) {
    throw new Error("Expected get_weather to be present in the test manifest.");
  }
  runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
    default: {
      execute: getWeatherTool.execute,
    },
  };
  return {
    completeCalls: () => completeCalls,
    completedPrincipals: () => completedPrincipals,
    runtime,
  };
}

export function authorizationAttemptId(events: readonly MessageStreamEvent[]): string {
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

export function expectSingleTurn(events: readonly MessageStreamEvent[], turnId: string): void {
  expect(filterEventsByType(events, "turn.started")).toHaveLength(1);
  const eventTurnIds = events.flatMap((event) => {
    if (!("data" in event) || typeof event.data !== "object" || event.data === null) return [];
    if (!("turnId" in event.data) || typeof event.data.turnId !== "string") return [];
    return [event.data.turnId];
  });
  expect(eventTurnIds.length).toBeGreaterThan(0);
  expect(new Set(eventTurnIds)).toEqual(new Set([turnId]));
}

const CALLER_STEP_NAMES = new Set([
  "bindTurnCallerContextStep",
  "notifyTurnCallerStep",
  "resolveInitialTurnCallerStep",
]);

export async function listCallerStepNames(runId: string): Promise<string[]> {
  return (await listStepNames(runId)).filter((name) => CALLER_STEP_NAMES.has(name)).sort();
}

async function listStepNames(runId: string): Promise<string[]> {
  const world = await getWorld();
  const steps = await world.steps.list({
    pagination: { limit: 1_000 },
    resolveData: "none",
    runId,
  });
  return steps.data.map((step) => step.stepName.split("//").at(-1) ?? "");
}

export interface CapturedEventStream {
  dispose(): void;
  nextUntil(
    label: string,
    predicate: (event: MessageStreamEvent) => boolean,
  ): Promise<MessageStreamEvent[]>;
}

export function captureEvents(run: Parameters<typeof captureTurnEvents>[0]): CapturedEventStream {
  const reader = run.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let disposed = false;

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      reader.releaseLock();
    },
    nextUntil(label, predicate) {
      if (disposed) {
        return Promise.reject(new Error("CapturedEventStream: stream already disposed."));
      }
      return withTimeout(readUntil(reader, decoder, buffer, predicate), label).then((result) => {
        buffer = result.buffer;
        return result.events;
      });
    },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
  initialBuffer: string,
  predicate: (event: MessageStreamEvent) => boolean,
): Promise<{ buffer: string; events: MessageStreamEvent[] }> {
  const events: MessageStreamEvent[] = [];
  let buffer = initialBuffer;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      throw new Error("Workflow stream closed before reaching the expected event.");
    }

    buffer += decoder.decode(value);

    for (
      let newlineIndex = buffer.indexOf("\n");
      newlineIndex !== -1;
      newlineIndex = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const event = JSON.parse(line) as MessageStreamEvent;
      events.push(event);

      if (predicate(event)) {
        return { buffer, events };
      }
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}.`));
        }, 30_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function expectHookClaims(
  runId: string,
  tokens: string[],
  options: { readonly turnStarted?: boolean } = {},
): Promise<void> {
  const events = await (
    await getWorld()
  ).events.list({
    runId,
    pagination: { limit: 1000 },
    resolveData: "all",
  });
  const claims = events.data.flatMap((event) =>
    event.eventType === "hook_created" ? [event.eventData.token] : [],
  );
  const signals = claims.filter((token) => token.startsWith("abrt_"));
  expect(signals).toHaveLength(options.turnStarted === false ? 0 : 2);
  expect(claims.filter((token) => !token.startsWith("abrt_")).sort()).toEqual(
    tokens.map(sessionInboxHookToken).sort(),
  );
}

export async function waitForRuntimeActionResult(runId: string, callId: string): Promise<unknown> {
  const world = await getWorld();
  const deadline = Date.now() + 10_000;
  let receivedPayloads: unknown[] = [];

  while (Date.now() < deadline) {
    const events = await world.events.list({
      pagination: { limit: 1000 },
      resolveData: "all",
      runId,
    });
    receivedPayloads = [];

    for (const event of events.data) {
      if (event.eventType === "hook_received") {
        const payload = await hydrateWorkflowArguments(event.eventData.payload, runId, undefined);
        receivedPayloads.push(payload);
        if (hasSubagentResult(payload, callId)) {
          return payload;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for delegated result "${callId}". Received: ${JSON.stringify(receivedPayloads)}`,
  );
}

export async function waitForSubagentInputRequest(runId: string, callId: string): Promise<unknown> {
  const world = await getWorld();
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const events = await world.events.list({
      pagination: { limit: 1000 },
      resolveData: "all",
      runId,
    });
    for (const event of events.data) {
      if (event.eventType !== "hook_received") continue;
      const payload = await hydrateWorkflowArguments(event.eventData.payload, runId, undefined);
      if (
        typeof payload === "object" &&
        payload !== null &&
        "kind" in payload &&
        payload.kind === "subagent-input-request" &&
        "callId" in payload &&
        payload.callId === callId
      ) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for a subagent input request from caller "${callId}".`);
}

function hasSubagentResult(value: unknown, callId: string): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "runtime-action-result" ||
    !("results" in value) ||
    !Array.isArray(value.results)
  ) {
    return false;
  }

  return value.results.some(
    (result) =>
      typeof result === "object" &&
      result !== null &&
      "callId" in result &&
      result.callId === callId,
  );
}

export async function readSessionTimer(
  ownerRunId: string,
): Promise<{ runId: string; deadline: Date }> {
  const world = await getWorld();
  let timer: { runId: string; deadline: Date } | undefined;
  await vi.waitFor(async () => {
    const steps = await world.steps.list({ runId: ownerRunId, resolveData: "all" });
    const start = steps.data.find((step) => step.stepName.endsWith("//startSessionTimeoutStep"));
    expect(start?.output).toBeDefined();
    const result = (await hydrateStepReturnValue(start!.output, ownerRunId, undefined)) as {
      runId: string;
    };
    const run = await world.runs.get(result.runId);
    const [input] = (await hydrateWorkflowArguments(run.input, run.runId, undefined)) as [
      { deadline: Date },
    ];
    timer = { runId: run.runId, deadline: input.deadline };
  });
  return timer!;
}
