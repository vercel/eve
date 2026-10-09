import { asSchema, type JSONSchema7, jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, type Session } from "#context/keys.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { always, never, once } from "#tools/approval/policies.js";

import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_EXA_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
  WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA,
} from "#harness/provider-tool-schemas.js";
import type { JsonObject } from "#shared/json.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveModelProfile } from "#harness/model-profile.js";
import {
  approvalStatus,
  buildToolSet,
  buildToolSetWithProviderTools,
  invokeTool,
  isRunnableTool,
} from "#harness/tools.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import type { HarnessToolMap } from "#harness/types.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { ApprovalContext } from "#approval/definition.js";
import type { ToolContext } from "#tools/definition.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { BASH_INPUT_SCHEMA, BASH_OUTPUT_SCHEMA } from "#tools/provided/bash.js";
import { toInputSchema, UNSPECIFIED_INPUT_SCHEMA } from "#tools/schema.js";

function getJsonSchema(tool: unknown): unknown {
  return (tool as { inputSchema: { jsonSchema: unknown } }).inputSchema.jsonSchema;
}

function directModel(provider: string): LanguageModel {
  return new MockLanguageModelV3({ provider });
}

function describeTool(definition: HarnessToolDefinition): string {
  return definition.description;
}

function getOutputJsonSchema(tool: unknown): unknown {
  return (tool as { outputSchema: { jsonSchema: unknown } }).outputSchema.jsonSchema;
}

async function resolveApproval(
  tools: HarnessToolMap,
  toolName: string,
  input: unknown,
  session?: Session,
  options: {
    readonly abortSignal?: AbortSignal;
    readonly approvedTools?: ReadonlySet<string>;
  } = {},
): Promise<unknown> {
  const definition = tools.get(toolName);
  if (definition === undefined) throw new TypeError(`Missing test tool "${toolName}".`);
  const activeSession = session ?? {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  };
  const ctx = new ContextContainer();
  ctx.set(SessionKey, activeSession);
  return contextStorage.run(ctx, () =>
    approvalStatus(definition, {
      abortSignal: options.abortSignal,
      approvedTools: options.approvedTools,
      callId: "call_1",
      input,
    }),
  );
}

async function executeSdkTool(input: {
  readonly abortSignal?: AbortSignal;
  readonly messages?: ToolExecuteOptions["messages"];
  readonly tool: HarnessToolDefinition | undefined;
  readonly toolCallId?: string;
  readonly toolInput?: unknown;
}): Promise<unknown> {
  if (!isRunnableTool(input.tool)) throw new TypeError("Missing runnable test tool.");
  return await invokeTool(input.tool, input.toolInput ?? {}, {
    abortSignal: input.abortSignal,
    messages: input.messages ?? [],
    toolCallId: input.toolCallId ?? "call_1",
  });
}

async function projectSdkToolOutput(input: {
  readonly output: unknown;
  readonly tool: HarnessToolDefinition | undefined;
  readonly toolCallId?: string;
}): Promise<unknown> {
  if (input.tool === undefined) throw new TypeError("Missing test tool.");
  return await toolCallModelOutput(input.tool, input.output, input.toolCallId ?? "call_1");
}

describe("buildToolSet", () => {
  it("forwards the AI SDK execute options to the tool definition", async () => {
    const abortController = new AbortController();
    let receivedOptions: ToolExecuteOptions | undefined;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "observe_options",
        {
          description: "Observe the AI SDK execute options.",
          execute: (_input: unknown, options?: ToolExecuteOptions) => {
            receivedOptions = options;
            return { ok: true };
          },
          inputSchema: jsonSchema({ type: "object" }),
          name: "observe_options",
        },
      ],
    ]);

    await executeSdkTool({
      abortSignal: abortController.signal,
      tool: tools.get("observe_options"),
      toolCallId: "call_observe",
    });

    expect(receivedOptions?.abortSignal).toBe(abortController.signal);
    expect(receivedOptions?.toolCallId).toBe("call_observe");
  });

  it("passes the AI SDK abort signal to the authored tool context", async () => {
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "observe_signal",
        {
          description: "Observe the active turn signal.",
          execute: createToolExecuteWithAuth({
            execute(_input, ctx) {
              receivedSignal = (ctx as ToolContext).abortSignal;
              return { ok: true };
            },
            scope: "observe_signal",
          }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "observe_signal",
        },
      ],
    ]);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });

    await contextStorage.run(ctx, () =>
      executeSdkTool({
        abortSignal: abortController.signal,
        tool: tools.get("observe_signal"),
      }),
    );

    expect(receivedSignal).toBe(abortController.signal);
  });

  it("preserves authored async generators for the AI SDK", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "stream_progress",
        {
          description: "Stream progress.",
          execute: createToolExecuteWithAuth({
            async *execute() {
              yield { stage: "started" };
              yield { stage: "complete" };
            },
            scope: "stream_progress",
          }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "stream_progress",
        },
      ],
    ]);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });

    await contextStorage.run(ctx, async () => {
      const definition = tools.get("stream_progress");
      if (!isRunnableTool(definition)) throw new TypeError("Missing runnable test tool.");
      const output = invokeTool(definition, {}, { messages: [], toolCallId: "call_stream" });
      expect(isAsyncIterable(output)).toBe(true);

      const values: unknown[] = [];
      for await (const value of output as AsyncIterable<unknown>) {
        values.push(value);
      }
      expect(values).toEqual([{ stage: "started" }, { stage: "complete" }]);
    });
  });

  it("supplies an inert abort signal when the SDK provides none", async () => {
    let receivedSignal: AbortSignal | undefined;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "observe_signal",
        {
          description: "Observe the active turn signal.",
          execute: createToolExecuteWithAuth({
            execute(_input, ctx) {
              receivedSignal = (ctx as ToolContext).abortSignal;
              return { ok: true };
            },
            scope: "observe_signal",
          }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "observe_signal",
        },
      ],
    ]);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });

    await contextStorage.run(ctx, () => executeSdkTool({ tool: tools.get("observe_signal") }));

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("passes the AI SDK toolCallId to the authored tool context as callId", async () => {
    let receivedCallId: string | undefined;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "observe_call_id",
        {
          description: "Observe the tool call id.",
          execute: createToolExecuteWithAuth({
            execute(_input, ctx) {
              receivedCallId = (ctx as ToolContext).callId;
              return { ok: true };
            },
            scope: "observe_call_id",
          }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "observe_call_id",
        },
      ],
    ]);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });

    await contextStorage.run(ctx, () =>
      executeSdkTool({ tool: tools.get("observe_call_id"), toolCallId: "call_observe" }),
    );

    expect(receivedCallId).toBe("call_observe");
  });

  it("passes the AI SDK step messages to the authored tool context", async () => {
    let receivedMessages: ToolContext["messages"] | undefined;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "observe_messages",
        {
          description: "Observe the step messages.",
          execute: createToolExecuteWithAuth({
            execute(_input, ctx) {
              receivedMessages = (ctx as ToolContext).messages;
              return { ok: true };
            },
            scope: "observe_messages",
          }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "observe_messages",
        },
      ],
    ]);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });
    const messages: ToolExecuteOptions["messages"] = [
      { content: "Can I talk to a person?", role: "user" },
      { content: "Let me check.", role: "assistant" },
    ];

    await contextStorage.run(ctx, () =>
      executeSdkTool({ messages, tool: tools.get("observe_messages") }),
    );

    expect(receivedMessages).toEqual(messages);
  });

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

    const result = buildToolSet({ describe: describeTool, tools });

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

    const result = buildToolSet({ describe: describeTool, tools });

    expect(getOutputJsonSchema(result.summarize)).toEqual(outputSchema);
  });

  it("hands the AI SDK only its own schema type, whatever produced the tool schema", async () => {
    // The AI SDK converts and parses Zod-vendored schemas with the app's own
    // Zod copy. Handing it anything but its own `Schema` lets a mismatched
    // copy crash mid-stream, so every source is lowered first.
    const remote = {
      anyOf: [{ required: ["page_id"] }, { required: ["title"] }],
      patternProperties: { "^x-": { type: "string" } },
      properties: {
        page_id: { format: "uuid", type: "string" },
        target: {
          allOf: [
            { properties: { id: { type: "string" } }, type: "object" },
            { properties: { kind: { enum: ["page", "database"] } }, type: "object" },
          ],
        },
        title: { type: "string" },
      },
      type: "object",
    };
    const sources: Record<string, HarnessToolDefinition["inputSchema"]> = {
      authored_zod: z
        .object({ id: z.string() })
        .and(z.object({ tags: z.record(z.string(), z.string()) })),
      framework: BASH_INPUT_SCHEMA,
      native: jsonSchema({ type: "object" }),
      remote: toInputSchema(remote),
      unspecified: UNSPECIFIED_INPUT_SCHEMA,
    };
    const tools: HarnessToolMap = new Map(
      Object.entries(sources).map(([name, inputSchema]) => [
        name,
        {
          description: name,
          execute: async (input: unknown) => input,
          inputSchema,
          name,
          outputSchema: name === "framework" ? BASH_OUTPUT_SCHEMA : undefined,
        },
      ]),
    );

    const result = buildToolSet({ describe: describeTool, tools });

    for (const tool of Object.values(result)) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        if (schema === undefined) continue;
        expect(Reflect.get(schema, Symbol.for("vercel.ai.schema"))).toBe(true);
        expect(asSchema(schema)).toBe(schema);
        expect("~standard" in schema).toBe(false);
        expect("_zod" in schema).toBe(false);
      }
    }
    expect(getJsonSchema(result.remote)).toEqual(remote);
    await expect(
      asSchema(result.remote!.inputSchema).validate?.({
        page_id: "1f2e3d4c5b6a79881f2e3d4c5b6a7988",
        target: { id: "db-1", kind: "database" },
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(asSchema(result.remote!.inputSchema).validate?.({})).resolves.toMatchObject({
      success: false,
    });
  });

  it("supports client-side tools without server executors", () => {
    const schema = {
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      type: "object",
    } satisfies JSONSchema7;
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "pick_color",
        {
          description: "Let the client pick a color.",
          inputSchema: jsonSchema(schema),
          name: "pick_color",
        },
      ],
    ]);

    const result = buildToolSet({ describe: describeTool, tools });

    expect(getJsonSchema(result.pick_color)).toEqual(schema);
  });

  it("omits tools whose name is in disabledProviderTools", () => {
    // The harness recovery path lists tools to drop after an AI Gateway
    // fallback provider rejected them. `buildToolSet` must honor the
    // list so the retry call does not re-send the offending tool.
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "web_search",
        {
          behavior: {
            availability: [],
            handling: { kind: "provider-tool", provider: "parallel" },
          },
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
      describe: describeTool,
      disabledProviderTools: new Set(["web_search"]),
      tools,
    });

    expect(result.web_search).toBeUndefined();
    expect(result.echo).toBeDefined();
  });

  it.each([
    ["openai/gpt-5.4", WEB_SEARCH_EXA_OUTPUT_SCHEMA],
    ["anthropic/claude-opus-4.6", WEB_SEARCH_EXA_OUTPUT_SCHEMA],
    [directModel("openai.chat"), WEB_SEARCH_OPENAI_OUTPUT_SCHEMA],
    [directModel("anthropic.messages"), WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA],
    [directModel("google.generative-ai"), WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA],
    ["mistral/mistral-large", WEB_SEARCH_EXA_OUTPUT_SCHEMA],
  ] satisfies Array<readonly [LanguageModel, JsonObject]>)(
    "injects the selected web_search provider output schema",
    async (model, expectedOutputSchema) => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "web_search",
          {
            behavior: {
              availability: [],
              handling: { kind: "provider-tool", provider: "exa" },
            },
            description: "Web search.",
            inputSchema: jsonSchema({}),
            name: "web_search",
          },
        ],
      ]);

      const result = await buildToolSetWithProviderTools({
        profile: resolveModelProfile(model),
        describe: describeTool,
        tools,
      });

      expect(getOutputJsonSchema(result.web_search)).toEqual(expectedOutputSchema);
    },
  );

  it("injects Parallel when configured for an AI Gateway model", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "web_search",
        {
          behavior: {
            availability: [],
            handling: { kind: "provider-tool", provider: "parallel" },
          },
          description: "Web search.",
          inputSchema: jsonSchema({}),
          name: "web_search",
        },
      ],
    ]);

    const result = await buildToolSetWithProviderTools({
      profile: resolveModelProfile("openai/gpt-5.4"),
      describe: describeTool,
      tools,
    });

    expect(getOutputJsonSchema(result.web_search)).toEqual(WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA);
  });

  it("injects Browserbase search with its Gateway schemas and respects availability", async () => {
    const tools: HarnessToolMap = new Map([
      [
        "web_search",
        {
          behavior: {
            availability: [],
            handling: { kind: "provider-tool", provider: "browserbase" },
          },
          description: "Search.",
          inputSchema: jsonSchema({}),
          name: "web_search",
        },
      ],
    ]);
    const result = await buildToolSetWithProviderTools({
      profile: resolveModelProfile("openai/gpt-5.4"),
      describe: describeTool,
      tools,
    });
    const search = result.web_search!;
    expect(search).toMatchObject({ type: "provider", id: "gateway.browserbase_search" });
    expect(search.execute).toBeUndefined();
    expect(search.outputSchema).toBeDefined();
    await expect(
      asSchema(search.outputSchema!).validate?.({ error: "rate_limit", message: "Try again." }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      asSchema(search.outputSchema!).validate?.({
        query: "example",
        requestId: "search-1",
        results: [{ id: "one", title: "Example Domain", url: "https://example.com" }],
      }),
    ).resolves.toMatchObject({ success: true });

    const disabled = await buildToolSetWithProviderTools({
      profile: resolveModelProfile("openai/gpt-5.4"),
      describe: describeTool,
      tools,
      disabledProviderTools: new Set(["web_search"]),
    });
    expect(disabled.web_search).toBeUndefined();

    const direct = await buildToolSetWithProviderTools({
      profile: resolveModelProfile(directModel("openai.chat")),
      describe: describeTool,
      tools,
    });
    expect(direct.web_search).toMatchObject({ id: "openai.web_search" });
  });

  it("omits provider-managed web_search when no provider backend is available", async () => {
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "web_search",
        {
          behavior: {
            availability: [],
            handling: { kind: "provider-tool", provider: "exa" },
          },
          description: "Web search.",
          inputSchema: jsonSchema({}),
          name: "web_search",
        },
      ],
    ]);

    const result = await buildToolSetWithProviderTools({
      profile: resolveModelProfile(directModel("some-provider")),
      describe: describeTool,
      tools,
    });

    expect(result.web_search).toBeUndefined();
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

    await expect(resolveApproval(tools, "dangerous_tool", {})).resolves.toBeUndefined();
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

    const projected = await projectSdkToolOutput({
      output: { full: "data", secret: "hidden" },
      tool: tools.get("report"),
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

    await expect(
      executeSdkTool({
        tool: tools.get("timestamp"),
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

    await expect(executeSdkTool({ tool: tools.get("report") })).resolves.toBe(output);
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

    await expect(executeSdkTool({ tool: tools.get("maybe_empty") })).resolves.toBeNull();
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

    await expect(
      projectSdkToolOutput({
        output: { ok: true },
        tool: tools.get("timestamp"),
        toolCallId: "call_timestamp",
      }),
    ).rejects.toThrow(
      'Tool "timestamp" call "call_timestamp" returned a non-JSON-serializable model output. Expected a JSON-serializable value.',
    );
  });

  it("passes valid content toModelOutput values through in the AI SDK shape", async () => {
    const pixel =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "screenshot",
        {
          description: "Capture a screenshot.",
          execute: async () => ({ ok: true }),
          inputSchema: jsonSchema({}),
          name: "screenshot",
          toModelOutput: () => ({
            type: "content" as const,
            value: [
              { type: "text" as const, text: "Screenshot:" },
              {
                type: "file" as const,
                data: { type: "data" as const, data: pixel },
                mediaType: "image/png",
                filename: "pixel.png",
              },
            ],
          }),
        },
      ],
    ]);

    await expect(
      projectSdkToolOutput({ output: { ok: true }, tool: tools.get("screenshot") }),
    ).resolves.toEqual({
      type: "content",
      value: [
        { type: "text", text: "Screenshot:" },
        {
          type: "file",
          data: { type: "data", data: pixel },
          mediaType: "image/png",
          filename: "pixel.png",
        },
      ],
    });
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

    await expect(
      projectSdkToolOutput({
        output: { ok: true },
        tool: tools.get("report"),
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

      await expect(resolveApproval(tools, "dangerous", {})).resolves.toBe("user-approval");
      await expect(resolveApproval(tools, "safe", {})).resolves.toBe("not-applicable");
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

      await expect(resolveApproval(tools, "delete_account", {})).resolves.toEqual({
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
      await expect(resolveApproval(tools, "bash", {})).resolves.toBe("user-approval");
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
      await expect(resolveApproval(tools, "bash", {})).resolves.toBe("not-applicable");
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
      await expect(resolveApproval(tools, "bash", {})).resolves.toBe("user-approval");
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

      await expect(
        resolveApproval(tools, "bash", {}, undefined, { approvedTools: new Set(["bash"]) }),
      ).resolves.toBe("not-applicable");
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
      await expect(resolveApproval(tools, "bash", {})).resolves.toBe("user-approval");
      await expect(resolveApproval(tools, "write_file", {})).resolves.toBeUndefined();
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

      const toolInput = { teamId: "team_abc", limit: 20 };
      await resolveApproval(tools, "vercel__list_projects", toolInput);

      expect(capturedInput).toEqual(toolInput);
    });

    it("passes the callId from the AI SDK into approval", async () => {
      let capturedCallId: string | undefined;
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "vercel__list_projects",
          {
            description: "List projects in the team.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "vercel__list_projects",
            approval: (ctx) => {
              capturedCallId = ctx.callId;
              return "user-approval";
            },
          },
        ],
      ]);

      await resolveApproval(tools, "vercel__list_projects", {});

      expect(capturedCallId).toBe("call_1");
    });

    it("passes cancellation into approval", async () => {
      let capturedSignal: AbortSignal | undefined;
      const tools: HarnessToolMap = new Map([
        [
          "deploy",
          {
            approval: (ctx: ApprovalContext) => {
              capturedSignal = ctx.abortSignal;
              return "user-approval";
            },
            description: "Deploy the application.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "deploy",
          },
        ],
      ]);
      const abortSignal = new AbortController().signal;

      await resolveApproval(tools, "deploy", {}, undefined, { abortSignal });

      expect(capturedSignal).toBe(abortSignal);
    });

    it("passes the active caller and session context into approval", async () => {
      let capturedCtx: ApprovalContext | undefined;
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

      await expect(resolveApproval(tools, "delete_project", {}, session)).resolves.toBe(
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
    });

    it("uses the active principal for schedule approval", async () => {
      const human: NonNullable<Session["auth"]["current"]> = {
        attributes: {},
        authenticator: "test",
        principalId: "eve:app",
        principalType: "user",
      };
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "refund",
          {
            approval: ({ session }) => {
              const auth = session.auth.current;
              return auth?.authenticator === SCHEDULE_APP_AUTH.authenticator &&
                auth.principalId === SCHEDULE_APP_AUTH.principalId &&
                auth.principalType === SCHEDULE_APP_AUTH.principalType
                ? "not-applicable"
                : "user-approval";
            },
            description: "Refund a charge.",
            execute: async () => "ok",
            inputSchema: jsonSchema({ type: "object" }),
            name: "refund",
          },
        ],
      ]);
      const scheduleSession: Session = {
        auth: { current: SCHEDULE_APP_AUTH, initiator: SCHEDULE_APP_AUTH },
        sessionId: "schedule-session",
        turn: { id: "schedule-turn", sequence: 0 },
      };
      const humanResumedSession: Session = {
        auth: { current: human, initiator: SCHEDULE_APP_AUTH },
        sessionId: "schedule-session",
        turn: { id: "human-turn", sequence: 1 },
      };

      await expect(resolveApproval(tools, "refund", {}, scheduleSession)).resolves.toBe(
        "not-applicable",
      );
      await expect(resolveApproval(tools, "refund", {}, humanResumedSession)).resolves.toBe(
        "user-approval",
      );
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

      const approvedTools = new Set(["vercel__list_projects:team_abc"]);
      await expect(
        resolveApproval(
          tools,
          "vercel__list_projects",
          { teamId: "team_abc", limit: 10 },
          undefined,
          { approvedTools },
        ),
      ).resolves.toBe("not-applicable");

      await expect(
        resolveApproval(
          tools,
          "vercel__list_projects",
          { teamId: "team_xyz", limit: 10 },
          undefined,
          { approvedTools },
        ),
      ).resolves.toBe("user-approval");
    });
  });
});
