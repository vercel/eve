import { type JSONSchema7, jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, type Session } from "#context/keys.js";
import { always, never, once } from "#public/tools/approval/approval-helpers.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
  WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA,
} from "#runtime/framework-tools/web-search.js";
import type { JsonObject } from "#shared/json.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildToolApproval, buildToolSet, buildToolSetWithProviderTools } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";

function getJsonSchema(tool: unknown): unknown {
  return (tool as { inputSchema: { jsonSchema: unknown } }).inputSchema.jsonSchema;
}

function getOutputJsonSchema(tool: unknown): unknown {
  return (tool as { outputSchema: { jsonSchema: unknown } }).outputSchema.jsonSchema;
}

async function resolveApproval(
  tools: ReturnType<typeof buildToolSet>,
  toolName: string,
  input: unknown,
  session: Session = {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  },
): Promise<unknown> {
  const approval = buildToolApproval(tools);
  if (typeof approval !== "function") throw new TypeError("Expected generic approval function.");
  const ctx = new ContextContainer();
  ctx.set(SessionKey, session);
  return contextStorage.run(ctx, () =>
    approval({
      messages: [],
      runtimeContext: {},
      toolCall: { input, toolCallId: "call_1", toolName } as never,
      tools,
      toolsContext: {} as never,
    }),
  );
}

async function executeSdkTool(input: {
  readonly tool: unknown;
  readonly toolCallId?: string;
  readonly toolInput?: unknown;
}): Promise<unknown> {
  const execute = (
    input.tool as {
      readonly execute?: (
        toolInput: unknown,
        options: { readonly toolCallId: string },
      ) => Promise<unknown> | unknown;
    }
  ).execute;
  expect(execute).toBeTypeOf("function");
  return await execute!(input.toolInput ?? {}, { toolCallId: input.toolCallId ?? "call_1" });
}

async function projectSdkToolOutput(input: {
  readonly output: unknown;
  readonly tool: unknown;
  readonly toolCallId?: string;
}): Promise<unknown> {
  const toModelOutput = (
    input.tool as {
      readonly toModelOutput?: (options: {
        readonly input: unknown;
        readonly output: unknown;
        readonly toolCallId: string;
      }) => Promise<unknown> | unknown;
    }
  ).toModelOutput;
  expect(toModelOutput).toBeTypeOf("function");
  return await toModelOutput!({
    input: {},
    output: input.output,
    toolCallId: input.toolCallId ?? "call_1",
  });
}

describe("buildToolSet", () => {
  it("passes through the input schema to the SDK tool", () => {
    const schema = {
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    } satisfies JSONSchema7;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "echo_city",
        {
          description: "Echo one city.",
          execute: async () => "ok",
          inputSchema: jsonSchema(schema),
          name: "echo_city",
        },
      ],
    ]);

    const result = buildToolSet({ tools });

    expect(getJsonSchema(result.echo_city)).toEqual(schema);
  });

  it("passes through the output schema to the SDK tool", () => {
    const outputSchema = {
      properties: { summary: { type: "string" } },
      required: ["summary"],
      type: "object",
    } satisfies JSONSchema7;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "summarize",
        {
          description: "Summarize data.",
          execute: async () => ({ summary: "ok" }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "summarize",
          outputSchema: jsonSchema(outputSchema),
        },
      ],
    ]);

    const result = buildToolSet({ tools });

    expect(getOutputJsonSchema(result.summarize)).toEqual(outputSchema);
  });

  it("supports client-side tools without server executors", () => {
    const schema = {
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      type: "object",
    } satisfies JSONSchema7;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "ask_question",
        {
          description: "Ask the user a question.",
          inputSchema: jsonSchema(schema),
          name: "ask_question",
        },
      ],
    ]);

    const result = buildToolSet({ capabilities: { requestInput: true }, tools });

    expect(getJsonSchema(result.ask_question)).toEqual(schema);
  });

  it("omits tools whose name is in disabledProviderTools", () => {
    // The harness recovery path lists tools to drop after an AI Gateway
    // fallback provider rejected them. `buildToolSet` must honor the
    // list so the retry call does not re-send the offending tool.
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "web_search",
        {
          description: "Web search.",
          inputSchema: jsonSchema({}),
          name: "web_search",
        },
      ],
      [
        "echo",
        {
          description: "Echo.",
          execute: async () => "ok",
          inputSchema: jsonSchema({}),
          name: "echo",
        },
      ],
    ]);

    const result = buildToolSet({
      disabledProviderTools: new Set(["web_search"]),
      tools,
    });

    expect(result.web_search).toBeUndefined();
    expect(result.echo).toBeDefined();
  });

  it.each([
    [{ id: "openai/gpt-5.4" }, WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA],
    [{ id: "anthropic/claude-opus-4.6" }, WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA],
    [
      {
        id: "openai.chat/gpt-5.4",
        source: {
          exportName: "model",
          logicalPath: "agent.ts",
          sourceId: "agent.ts",
          sourceKind: "module",
        },
      },
      WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
    ],
    [
      {
        id: "anthropic.messages/claude-opus-4.6",
        source: {
          exportName: "model",
          logicalPath: "agent.ts",
          sourceId: "agent.ts",
          sourceKind: "module",
        },
      },
      WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
    ],
    [
      {
        id: "google.generative-ai/gemini-3.1-pro",
        source: {
          exportName: "model",
          logicalPath: "agent.ts",
          sourceId: "agent.ts",
          sourceKind: "module",
        },
      },
      WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
    ],
    [{ id: "mistral/mistral-large" }, WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA],
  ] satisfies Array<readonly [RuntimeModelReference, JsonObject]>)(
    "injects the selected web_search provider output schema",
    async (modelReference, expectedOutputSchema) => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "web_search",
          {
            description: "Web search.",
            inputSchema: jsonSchema({}),
            name: "web_search",
          },
        ],
      ]);

      const result = await buildToolSetWithProviderTools({
        modelReference,
        tools,
      });

      expect(getOutputJsonSchema(result.web_search)).toEqual(expectedOutputSchema);
    },
  );

  it("omits provider-managed web_search when no provider backend is available", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "web_search",
        {
          description: "Web search.",
          inputSchema: jsonSchema({}),
          name: "web_search",
        },
      ],
    ]);

    const result = await buildToolSetWithProviderTools({
      modelReference: {
        id: "some-provider/some-model",
        source: {
          exportName: "model",
          logicalPath: "agent.ts",
          sourceId: "agent.ts",
          sourceKind: "module",
        },
      },
      tools,
    });

    expect(result.web_search).toBeUndefined();
  });

  it("omits ask_question when the session cannot request input", () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "ask_question",
        {
          description: "Ask the user a question.",
          inputSchema: jsonSchema({}),
          name: "ask_question",
        },
      ],
    ]);

    const withoutCapability = buildToolSet({ tools });
    const withCapability = buildToolSet({
      capabilities: { requestInput: true },
      tools,
    });

    expect(withoutCapability.ask_question).toBeUndefined();
    expect(withCapability.ask_question).toBeDefined();
  });

  it("defaults to no approval when no approval function is set", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "dangerous_tool",
        {
          description: "Do the risky thing.",
          execute: async () => "ok",
          inputSchema: jsonSchema({}),
          name: "dangerous_tool",
        },
      ],
    ]);

    const result = buildToolSet({
      tools,
    });

    await expect(resolveApproval(result, "dangerous_tool", {})).resolves.toBeUndefined();
  });

  it("forwards toModelOutput to the SDK tool", () => {
    const toModelOutput = (output: unknown) => ({
      type: "text" as const,
      value: String(output),
    });
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "report",
        {
          description: "Generate a report.",
          execute: async () => ({ full: "data", internal: "details" }),
          inputSchema: jsonSchema({}),
          name: "report",
          toModelOutput,
        },
      ],
    ]);

    const result = buildToolSet({ tools });
    const sdkTool = result.report as { toModelOutput?: (...args: unknown[]) => unknown };

    expect(sdkTool.toModelOutput).toBeTypeOf("function");
  });

  it("adds default toModelOutput for executable tools without an authored mapper", () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "echo",
        {
          description: "Echo.",
          execute: async () => "ok",
          inputSchema: jsonSchema({}),
          name: "echo",
        },
      ],
    ]);

    const result = buildToolSet({ tools });
    const sdkTool = result.echo as { toModelOutput?: unknown };

    expect(sdkTool.toModelOutput).toBeTypeOf("function");
  });

  it("toModelOutput wrapper passes only output to the authored function", async () => {
    let capturedOutput: unknown;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "report",
        {
          description: "Generate a report.",
          execute: async () => "ok",
          inputSchema: jsonSchema({}),
          name: "report",
          toModelOutput: (output: unknown) => {
            capturedOutput = output;
            return { type: "text" as const, value: "summary" };
          },
        },
      ],
    ]);

    const result = buildToolSet({ tools });
    const sdkTool = result.report as {
      toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;
    };

    const projected = await sdkTool!.toModelOutput!({
      toolCallId: "call_1",
      input: { query: "test" },
      output: { full: "data", secret: "hidden" },
    });

    expect(capturedOutput).toEqual({ full: "data", secret: "hidden" });
    expect(projected).toEqual({ type: "text", value: "summary" });
  });

  it("rejects non-JSON-serializable execute output at the tool boundary", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "timestamp",
        {
          description: "Return a timestamp.",
          execute: async () => ({ now: new Date("2026-01-02T03:04:05.000Z") }),
          inputSchema: jsonSchema({}),
          name: "timestamp",
        },
      ],
    ]);

    const result = buildToolSet({ tools });

    await expect(
      executeSdkTool({
        tool: result.timestamp,
        toolCallId: "call_timestamp",
      }),
    ).rejects.toThrow(
      'Tool "timestamp" call "call_timestamp" returned a non-JSON-serializable result. Expected a JSON-serializable value.',
    );
  });

  it("preserves valid execute output identity", async () => {
    const output = { summary: "ok" };
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "report",
        {
          description: "Return a report.",
          execute: async () => output,
          inputSchema: jsonSchema({}),
          name: "report",
        },
      ],
    ]);

    const result = buildToolSet({ tools });

    await expect(executeSdkTool({ tool: result.report })).resolves.toBe(output);
  });

  it("normalizes top-level undefined execute output to null", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "maybe_empty",
        {
          description: "Return no value.",
          execute: async () => undefined,
          inputSchema: jsonSchema({}),
          name: "maybe_empty",
        },
      ],
    ]);

    const result = buildToolSet({ tools });

    await expect(executeSdkTool({ tool: result.maybe_empty })).resolves.toBeNull();
  });

  it("rejects non-JSON-serializable toModelOutput JSON values", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "timestamp",
        {
          description: "Return a timestamp.",
          execute: async () => ({ ok: true }),
          inputSchema: jsonSchema({}),
          name: "timestamp",
          toModelOutput: () => ({
            type: "json" as const,
            value: { now: new Date("2026-01-02T03:04:05.000Z") },
          }),
        },
      ],
    ]);

    const result = buildToolSet({ tools });

    await expect(
      projectSdkToolOutput({
        output: { ok: true },
        tool: result.timestamp,
        toolCallId: "call_timestamp",
      }),
    ).rejects.toThrow(
      'Tool "timestamp" call "call_timestamp" returned a non-JSON-serializable model output. Expected a JSON-serializable value.',
    );
  });

  it("passes valid text toModelOutput values through", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "report",
        {
          description: "Return a report.",
          execute: async () => ({ ok: true }),
          inputSchema: jsonSchema({}),
          name: "report",
          toModelOutput: () => ({ type: "text" as const, value: "visible" }),
        },
      ],
    ]);

    const result = buildToolSet({ tools });

    await expect(
      projectSdkToolOutput({
        output: { ok: true },
        tool: result.report,
      }),
    ).resolves.toEqual({
      type: "text",
      value: "visible",
    });
  });

  describe("tool-level approval override", () => {
    it("normalizes boolean approval results", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "dangerous",
          {
            approval: () => true,
            description: "Perform a dangerous action.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "dangerous",
          },
        ],
        [
          "safe",
          {
            approval: async () => false,
            description: "Perform a safe action.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "safe",
          },
        ],
      ]);

      const result = buildToolSet({ tools });
      await expect(resolveApproval(result, "dangerous", {})).resolves.toBe("user-approval");
      await expect(resolveApproval(result, "safe", {})).resolves.toBe("not-applicable");
    });

    it("preserves async AI SDK 7 approval statuses", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "delete_account",
          {
            approval: async () => ({ type: "denied", reason: "Account is protected." }),
            description: "Delete an account.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "delete_account",
          },
        ],
      ]);

      const result = buildToolSet({ tools });
      await expect(resolveApproval(result, "delete_account", {})).resolves.toEqual({
        type: "denied",
        reason: "Account is protected.",
      });
    });

    it("always() requires approval", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "bash",
          {
            description: "Run a command.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "bash",
            approval: always(),
          },
        ],
      ]);

      const result = buildToolSet({
        tools,
      });
      await expect(resolveApproval(result, "bash", {})).resolves.toBe("user-approval");
    });

    it("never() skips approval", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "bash",
          {
            description: "Run a command.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "bash",
            approval: never(),
          },
        ],
      ]);

      const result = buildToolSet({
        tools,
      });
      await expect(resolveApproval(result, "bash", {})).resolves.toBe("not-applicable");
    });

    it("once() requires approval when tool not yet approved", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "bash",
          {
            description: "Run a command.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "bash",
            approval: once(),
          },
        ],
      ]);

      const result = buildToolSet({
        tools,
      });
      await expect(resolveApproval(result, "bash", {})).resolves.toBe("user-approval");
    });

    it("once() skips approval when tool already approved", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "bash",
          {
            description: "Run a command.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "bash",
            approval: once(),
          },
        ],
      ]);

      const result = buildToolSet({
        approvedTools: new Set(["bash"]),
        tools,
      });
      await expect(resolveApproval(result, "bash", {})).resolves.toBe("not-applicable");
    });

    it("tool without approval defaults to false when another tool has an override", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "bash",
          {
            description: "Run a command.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "bash",
            approval: always(),
          },
        ],
        [
          "write_file",
          {
            description: "Write a file.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "write_file",
          },
        ],
      ]);

      const result = buildToolSet({
        tools,
      });
      await expect(resolveApproval(result, "bash", {})).resolves.toBe("user-approval");
      await expect(resolveApproval(result, "write_file", {})).resolves.toBeUndefined();
    });

    it("passes toolInput from the AI SDK into approval", async () => {
      let capturedInput: unknown;
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "vercel__list_projects",
          {
            description: "List projects in the team.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "vercel__list_projects",
            approval: (ctx) => {
              capturedInput = ctx.toolInput;
              return "user-approval";
            },
          },
        ],
      ]);

      const result = buildToolSet({ tools });
      const toolInput = { teamId: "team_abc", limit: 20 };
      await resolveApproval(result, "vercel__list_projects", toolInput);

      expect(capturedInput).toEqual(toolInput);
    });

    it("passes the active caller and session context into approval", async () => {
      let capturedCtx: Parameters<NonNullable<HarnessToolDefinition["approval"]>>[0] | undefined;
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "delete_project",
          {
            approval: (ctx) => {
              capturedCtx = ctx;
              return ctx.session.auth.current?.attributes.tenant === "tenant_abc"
                ? "user-approval"
                : "denied";
            },
            description: "Delete a project.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "delete_project",
          },
        ],
      ]);
      const session: Session = {
        auth: {
          current: {
            attributes: { tenant: "tenant_abc" },
            authenticator: "jwt",
            principalId: "user_current",
            principalType: "user",
          },
          initiator: {
            attributes: { tenant: "tenant_abc" },
            authenticator: "jwt",
            principalId: "user_initiator",
            principalType: "user",
          },
        },
        parent: {
          callId: "call_parent",
          rootSessionId: "session_root",
          sessionId: "session_parent",
          turn: { id: "turn_parent", sequence: 1 },
        },
        sessionId: "session_current",
        turn: { id: "turn_current", sequence: 2 },
      };

      const result = buildToolSet({ tools });
      await expect(resolveApproval(result, "delete_project", {}, session)).resolves.toBe(
        "user-approval",
      );

      expect(capturedCtx?.session).toEqual({
        auth: session.auth,
        id: "session_current",
        parent: session.parent,
        turn: session.turn,
      });
      expect(capturedCtx?.session.auth.current?.principalId).toBe("user_current");
      expect(capturedCtx?.getSandbox).toBeTypeOf("function");
      expect(capturedCtx?.getSkill).toBeTypeOf("function");
    });

    it("input-aware approval skips when compound key is in approvedTools", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "vercel__list_projects",
          {
            description: "List projects in the team.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "vercel__list_projects",
            approval: ({ approvedTools, toolName, toolInput }) => {
              if (approvedTools.has(toolName)) return "not-applicable";
              const team = (toolInput as { teamId?: string } | undefined)?.teamId;
              if (team === undefined) return "user-approval";
              return approvedTools.has(`${toolName}:${team}`) ? "not-applicable" : "user-approval";
            },
          },
        ],
      ]);

      const withCompoundKey = buildToolSet({
        approvedTools: new Set(["vercel__list_projects:team_abc"]),
        tools,
      });
      await expect(
        resolveApproval(withCompoundKey, "vercel__list_projects", {
          teamId: "team_abc",
          limit: 10,
        }),
      ).resolves.toBe("not-applicable");

      await expect(
        resolveApproval(withCompoundKey, "vercel__list_projects", {
          teamId: "team_xyz",
          limit: 10,
        }),
      ).resolves.toBe("user-approval");
    });
  });
});
