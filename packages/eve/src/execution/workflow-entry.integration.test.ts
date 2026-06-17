import { describe, expect, it } from "vitest";
import { getWorld, resumeHook, start } from "#compiled/@workflow/core/runtime.js";

import type { SessionAuthContext } from "#channel/types.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { authHookToken } from "#harness/authorization.js";
import { ConnectionAuthorizationRequiredError } from "#public/connections/errors.js";
import type { ToolContext } from "#public/definitions/tool.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { AuthorizationDefinition, TokenResult } from "#runtime/connections/types.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { workflowEntry } from "#execution/workflow-entry.js";

function buildSerializedContext(overrides: {
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
    "eve.auth": null,
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

const TEST_USER_AUTH: SessionAuthContext = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "user-1",
  principalType: "user",
};

function buildInlineAuthWorkflowTool(): ResolvedToolDefinition {
  const githubAuth = buildInteractiveAuth({
    connector: "oauth/github",
    provider: "github",
    url: "https://idp.example/github",
  });
  const linearAuth = buildInteractiveAuth({
    connector: "oauth/linear",
    provider: "linear",
    url: "https://idp.example/linear",
  });
  const execute = async (_input: unknown, ctx: ToolContext) => {
    const tokens = await ctx.getTokens({
      github: [githubAuth, { displayName: "GitHub" }],
      linear: [linearAuth, { displayName: "Linear" }],
    });

    return {
      github: tokens.github.token,
      linear: tokens.linear.token,
    };
  };

  return {
    description: "Sync ticket data with GitHub and Linear credentials.",
    execute: execute as unknown as ResolvedToolDefinition["execute"],
    inputSchema: null,
    logicalPath: "tools/sync_ticket.ts",
    name: "sync_ticket",
    sourceId: "tools/sync_ticket.ts",
    sourceKind: "module",
  };
}

function attachInMemoryToolModule(runtime: TestRuntime, tool: ResolvedToolDefinition): void {
  const compiledTool = runtime.manifest.tools.find((entry) => entry.name === tool.name);
  if (compiledTool === undefined) {
    throw new Error(`Missing compiled manifest entry for tool "${tool.name}".`);
  }

  const nodeScope = Object.values(runtime.moduleMap.nodes).find(
    (scope) => scope.modules[compiledTool.sourceId] !== undefined,
  );
  if (nodeScope === undefined) {
    throw new Error(`Missing compiled module map entry for tool "${tool.name}".`);
  }

  nodeScope.modules[compiledTool.sourceId] = {
    default: {
      execute: tool.execute,
    },
  };
}

function buildInteractiveAuth(input: {
  readonly connector: string;
  readonly provider: string;
  readonly url: string;
}): AuthorizationDefinition {
  let token: TokenResult | undefined;

  return {
    principalType: "user",
    vercelConnect: { connector: input.connector },
    async getToken(): Promise<TokenResult> {
      if (token !== undefined) {
        return token;
      }

      throw new ConnectionAuthorizationRequiredError(input.connector);
    },
    async startAuthorization() {
      return {
        challenge: { url: input.url },
        resume: { provider: input.provider },
      };
    },
    async completeAuthorization({ callback, resume }): Promise<TokenResult> {
      const code = callback.params.code ?? "authorized";
      token = { token: `${readResumeProvider(resume) ?? input.provider}-${code}` };
      return token;
    },
  };
}

function readResumeProvider(resume: unknown): string | undefined {
  if (typeof resume !== "object" || resume === null || Array.isArray(resume)) {
    return undefined;
  }

  const provider = (resume as { readonly provider?: unknown }).provider;
  return typeof provider === "string" ? provider : undefined;
}

interface CapturedWorkflowEventStream {
  nextUntil(
    predicate: (events: readonly HandleMessageStreamEvent[]) => boolean,
  ): Promise<HandleMessageStreamEvent[]>;
  dispose(): void;
}

function captureWorkflowEventStream(run: {
  readonly readable: ReadableStream<Uint8Array>;
}): CapturedWorkflowEventStream {
  const reader = run.readable.getReader();
  const decoder = new TextDecoder();
  const state: { buffer: string } = { buffer: "" };
  let disposed = false;

  return {
    async nextUntil(predicate) {
      if (disposed) {
        throw new Error("CapturedWorkflowEventStream: stream already disposed.");
      }

      const events: HandleMessageStreamEvent[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error("Workflow stream closed before expected events were observed.");
        }

        state.buffer += decoder.decode(value);

        for (
          let newlineIndex = state.buffer.indexOf("\n");
          newlineIndex !== -1;
          newlineIndex = state.buffer.indexOf("\n")
        ) {
          const line = state.buffer.slice(0, newlineIndex).trim();
          state.buffer = state.buffer.slice(newlineIndex + 1);
          if (line.length === 0) continue;

          events.push(JSON.parse(line) as HandleMessageStreamEvent);
          if (predicate(events)) {
            return events;
          }
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      reader.releaseLock();
    },
  };
}

describe("workflowEntry integration", () => {
  it("parks in conversation mode and resumes via the workflow hook", async () => {
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

        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up" }],
        });

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

  it("surfaces multiple inline provider authorizations through the workflow stream", async () => {
    const tool = buildInlineAuthWorkflowTool();
    const runtime = createTestRuntime({
      agent: { name: "workflow-entry-inline-auth" },
      tools: [tool],
    });
    attachInMemoryToolModule(runtime, tool);
    const continuationToken = "http:workflow-entry-inline-auth";

    await runtime.run(async () => {
      const serializedContext = buildSerializedContext({
        channelKind: "http",
        continuationToken,
        mode: "conversation",
      });
      serializedContext["eve.auth"] = TEST_USER_AUTH;

      const run = await start(workflowEntry, [
        {
          input: { message: "Please call sync_ticket now." },
          serializedContext,
        },
      ]);

      const stream = captureWorkflowEventStream(run);

      try {
        const firstEvents = await stream.nextUntil(
          (events) => filterEventsByType(events, "authorization.required").length === 2,
        );
        const firstAuthRequired = filterEventsByType(firstEvents, "authorization.required");
        const authHook = await waitForHook(
          { runId: run.runId },
          {
            token: authHookToken(run.runId),
          },
        );

        expect(authHook.token).toBe(authHookToken(run.runId));
        expect(firstAuthRequired).toHaveLength(2);
        expect(firstAuthRequired).toMatchObject([
          {
            data: {
              authorization: {
                displayName: "GitHub",
                url: "https://idp.example/github",
              },
              name: "sync_ticket__oauth_github",
              webhookUrl: expect.stringContaining(
                "/eve/v1/connections/sync_ticket__oauth_github/callback/",
              ),
            },
          },
          {
            data: {
              authorization: {
                displayName: "Linear",
                url: "https://idp.example/linear",
              },
              name: "sync_ticket__oauth_linear",
              webhookUrl: expect.stringContaining(
                "/eve/v1/connections/sync_ticket__oauth_linear/callback/",
              ),
            },
          },
        ]);

        await resumeHook(authHook.token, {
          kind: "deliver",
          payloads: [
            {
              authorizationCallback: {
                callback: { method: "GET", params: { code: "github-code" } },
                connectionName: "sync_ticket__oauth_github",
              },
            },
            {
              authorizationCallback: {
                callback: { method: "GET", params: { code: "linear-code" } },
                connectionName: "sync_ticket__oauth_linear",
              },
            },
          ],
        });

        const secondEvents = await stream.nextUntil((events) =>
          events.some(
            (event) =>
              event.type === "session.waiting" ||
              event.type === "session.completed" ||
              event.type === "session.failed",
          ),
        );
        const completedAuth = filterEventsByType(secondEvents, "authorization.completed");
        const secondAuthRequired = filterEventsByType(secondEvents, "authorization.required");
        const actionResults = filterEventsByType(secondEvents, "action.result");

        expect(completedAuth).toHaveLength(2);
        expect(completedAuth).toMatchObject([
          {
            data: {
              name: "sync_ticket__oauth_github",
              outcome: "authorized",
            },
          },
          {
            data: {
              name: "sync_ticket__oauth_linear",
              outcome: "authorized",
            },
          },
        ]);
        expect(secondEvents.at(-1)?.type).toBe("session.waiting");
        expect(secondAuthRequired).toHaveLength(0);
        expect(actionResults).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({
                result: expect.objectContaining({
                  kind: "tool-result",
                  output: {
                    github: "github-github-code",
                    linear: "linear-linear-code",
                  },
                  toolName: "sync_ticket",
                }),
                status: "completed",
              }),
            }),
          ]),
        );
        expect(
          secondEvents.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("github-github-code") === true &&
              event.data.message.includes("linear-linear-code"),
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
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
      const run = await start(workflowEntry, [
        {
          input: { message: "session tag round-trip" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      try {
        // Drain the first turn — by the time it completes `createSessionStep`
        // has run and emitted the session-level `$eve.*` keys from inside
        // its own step body.
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
      const run = await start(workflowEntry, [
        {
          input: { message: "subagent tag round-trip" },
          serializedContext: buildSerializedContext({
            channelKind: "subagent",
            continuationToken: "subagent:parent-session:call-subagent-1",
            mode: "task",
            parent: {
              callId: "call-subagent-1",
              rootSessionId: "root-session",
              sessionId: "parent-session",
              turn: { id: "turn-parent", sequence: 2 },
            },
          }),
        },
      ]);

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
