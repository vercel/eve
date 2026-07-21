import { describe, expect, it } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";

import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
} from "#execution/eve-workflow-attributes.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { ConnectionAuthorizationRequiredError } from "#public/connections/errors.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { ToolContext } from "#public/definitions/tool.js";
import type { AuthorizationDefinition, TokenResult } from "#runtime/connections/types.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#shared/tool-schema.js";

function buildSerializedContext(overrides: {
  auth?: Record<string, unknown>;
  channelKind: string;
  continuationToken: string;
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
  const context: Record<string, unknown> = {
    "eve.auth": overrides.auth ?? null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: overrides.channelKind, state: {} },
    "eve.continuationToken": overrides.continuationToken,
    "eve.mode": overrides.mode,
  };
  if (overrides.parent !== undefined) {
    context["eve.parentSession"] = overrides.parent;
  }
  return context;
}

describe("workflowEntry integration", () => {
  it("resumes normal follow-ups after an interactive authorization callback", async () => {
    let completeCalls = 0;
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
      async completeAuthorization({ callback, resume }): Promise<TokenResult> {
        completeCalls += 1;
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
      sourceId: "tools/get_weather.ts",
      sourceKind: "module",
    };
    const runtime = createTestRuntime({
      agent: { name: "workflow-entry-auth-followup" },
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
    const continuationToken = "http:workflow-entry-auth-followup";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Use the get_weather tool to check the weather in Lisbon." },
          serializedContext: buildSerializedContext({
            auth: {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        const required = filterEventsByType(firstTurn, "authorization.required");

        expect(firstTurn.at(-1)?.type).toBe("authorization.required");
        expect(required).toHaveLength(1);
        expect(required[0]?.data).toMatchObject({
          name: "weather",
          authorization: { displayName: "Weather" },
        });

        await resumeHook(`${run.runId}:auth`, {
          kind: "deliver",
          payloads: [
            {
              authorizationCallback: {
                callback: {
                  method: "GET",
                  params: { code: "oauth-code" },
                },
                connectionName: "weather",
              },
            },
          ],
        });

        const authorizedTurn = await stream.nextUntil(
          "authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        const completed = filterEventsByType(authorizedTurn, "authorization.completed");

        expect(completeCalls).toBe(1);
        expect(authorizedTurn.at(-1)?.type).toBe("session.waiting");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.data).toMatchObject({
          name: "weather",
          outcome: "authorized",
        });
        expect(
          authorizedTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Used local weather tool for Lisbon") === true,
          ),
        ).toBe(true);

        await waitForHook(
          { runId: run.runId },
          {
            token: continuationToken,
          },
        );
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after auth" }],
        });

        const followupTurn = await stream.nextUntil(
          "post-auth follow-up turn",
          (event) => event.type === "session.waiting",
        );

        expect(followupTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          followupTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after auth") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("parks in conversation mode and resumes via runtime delivery", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-conversation" } });
    const continuationToken = "http:workflow-entry-conversation";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      const hook = await waitForHook(
        { runId: run.runId },
        {
          token: continuationToken,
        },
      );

      try {
        const firstTurn = await stream.nextTurn();

        expect(hook.token).toBe(continuationToken);
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        expect(firstTurn.every((event) => typeof event.meta?.at === "string")).toBe(true);
        expect(
          firstTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("hello there") === true,
          ),
        ).toBe(true);

        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        await expect(
          workflowRuntime.deliver({
            auth: null,
            continuationToken,
            payload: { message: "follow up" },
          }),
        ).resolves.toEqual({ sessionId: run.runId });

        const secondTurn = await stream.nextTurn();

        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        expect(secondTurn.every((event) => typeof event.meta?.at === "string")).toBe(true);
        expect(
          secondTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("fails a competing continuation owner before its first turn", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-hook-owner" } });
    const continuationToken = "http:workflow-entry-hook-owner";

    await runtime.run(async () => {
      const owner = await start(workflowEntry, [
        {
          input: { message: "owner message" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const ownerStream = captureTurnEvents(owner);
      await waitForHook({ runId: owner.runId }, { token: continuationToken });

      const firstTurn = await ownerStream.nextTurn();
      expect(firstTurn.at(-1)?.type).toBe("session.waiting");

      const contender = await start(workflowEntry, [
        {
          input: { message: "contending message" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const contenderStream = captureTurnEvents(contender);

      try {
        const contenderEvents = await contenderStream.nextTurn();

        expect(contenderEvents.at(-1)?.type).toBe("session.failed");
        expect(
          contenderEvents.some(
            (event) => event.type === "message.completed" || event.type === "turn.started",
          ),
        ).toBe(false);
        await expect(contender.returnValue).rejects.toThrow(/Hook token/);

        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "owner follow up" }],
        });
        const ownerFollowUp = await ownerStream.nextTurn();

        expect(ownerFollowUp.at(-1)?.type).toBe("session.waiting");
        expect(
          ownerFollowUp.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("owner follow up") === true,
          ),
        ).toBe(true);
      } finally {
        contenderStream.dispose();
        ownerStream.dispose();
        await owner.cancel();
      }
    });
  });

  it("emits completed structured results for a conversation turn outputSchema", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-output-schema" } });
    const continuationToken = "http:workflow-entry-output-schema";
    const outputSchema = {
      properties: {
        count: { type: "integer" },
        title: { type: "string" },
      },
      required: ["title", "count"],
      type: "object",
    } as const;

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "summarize this", outputSchema },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      await waitForHook(
        { runId: run.runId },
        {
          token: continuationToken,
        },
      );

      try {
        const firstTurn = await stream.nextTurn();
        const results = filterEventsByType(firstTurn, "result.completed");

        expect(results).toHaveLength(1);
        expect(results[0]?.data.result).toEqual({
          count: 1,
          title: "structured-output",
        });
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");

        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up without structured output" }],
        });

        const secondTurn = await stream.nextTurn();

        expect(filterEventsByType(secondTurn, "result.completed")).toHaveLength(0);
        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes immediately in task mode", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-task" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("hello there"),
      });
      await expect(run.status).resolves.toBe("completed");
    });
  });

  it("returns agent-declared structured output in task mode", async () => {
    const outputSchema = {
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
      type: "object",
    } as const;
    const runtime = createTestRuntime({
      agent: { name: "workflow-entry-task-output-schema", outputSchema },
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task-output-schema",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: { summary: "structured-output" },
      });
      await expect(run.status).resolves.toBe("completed");
    });
  });

  it("emits `$eve.*` session attributes onto the parent workflow run", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-tags" } });
    const continuationToken = "http:workflow-entry-tags";

    await runtime.run(async () => {
      const serializedContext = buildSerializedContext({
        channelKind: "http",
        continuationToken,
        mode: "conversation",
      });
      const run = await start(
        workflowEntry,
        [
          {
            input: { message: "session tag round-trip" },
            serializedContext,
          },
        ],
        {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(
            buildSessionAttributes({
              inputMessage: "session tag round-trip",
              serializedContext,
            }),
          ),
        },
      );

      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();

        const world = await getWorld();
        const persisted = await world.runs.get(run.runId);
        const attrs = (persisted as { attributes?: Record<string, string> }).attributes ?? {};

        expect(attrs["$eve.type"]).toBe("session");
        expect(attrs["$eve.trigger"]).toBe("http");
        expect(attrs["$eve.title"]).toContain("session tag round-trip");
        // Top-level sessions have no parent or subagent name on the root run.
        expect(attrs["$eve.parent"]).toBeUndefined();
        expect(attrs["$eve.subagent"]).toBeUndefined();
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("emits parent lineage onto a subagent workflow run", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-subagent-tags" } });

    await runtime.run(async () => {
      const serializedContext = buildSerializedContext({
        channelKind: "subagent",
        continuationToken: "subagent:parent-session:call-subagent-1",
        mode: "task",
        parent: {
          callId: "call-subagent-1",
          rootSessionId: "root-session",
          sessionId: "parent-session",
          turn: { id: "turn-parent", sequence: 2 },
        },
      });
      const run = await start(
        workflowEntry,
        [
          {
            input: { message: "subagent tag round-trip" },
            serializedContext,
          },
        ],
        {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(
            buildSubagentRootAttributes({
              identity: { nodeId: "researcher" },
              parentCallId: "call-subagent-1",
              parentSessionId: "parent-session",
              parentTurnId: "turn-parent",
              rootSessionId: "root-session",
              serializedContext,
            }),
          ),
        },
      );

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("subagent tag round-trip"),
      });
      await expect(run.status).resolves.toBe("completed");

      const world = await getWorld();
      const persisted = await world.runs.get(run.runId);
      const attrs = (persisted as { attributes?: Record<string, string> }).attributes ?? {};

      expect(attrs["$eve.type"]).toBe("subagent");
      expect(attrs["$eve.parent"]).toBe("parent-session");
      expect(attrs["$eve.parent_call"]).toBe("call-subagent-1");
      expect(attrs["$eve.parent_turn"]).toBe("turn-parent");
      expect(attrs["$eve.root"]).toBe("root-session");
      expect(attrs["$eve.trigger"]).toBe("subagent");
    });
  });
});

interface CapturedEventStream {
  dispose(): void;
  nextUntil(
    label: string,
    predicate: (event: HandleMessageStreamEvent) => boolean,
  ): Promise<HandleMessageStreamEvent[]>;
}

function captureEvents(run: Parameters<typeof captureTurnEvents>[0]): CapturedEventStream {
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
  predicate: (event: HandleMessageStreamEvent) => boolean,
): Promise<{ buffer: string; events: HandleMessageStreamEvent[] }> {
  const events: HandleMessageStreamEvent[] = [];
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

      const event = JSON.parse(line) as HandleMessageStreamEvent;
      events.push(event);

      if (predicate(event)) {
        return { buffer, events };
      }
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}.`));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
