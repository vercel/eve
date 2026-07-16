import {
  generateText,
  jsonSchema,
  tool,
  type JSONValue,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { describe, expect, it, vi } from "vitest";
import { createAnthropic } from "#compiled/@ai-sdk/anthropic/index.js";

import {
  applyProviderToolActivations,
  resolveToolActivationTransport,
} from "#harness/provider-tool-activation.js";
import { attachToolActivation, createToolActivationId } from "#harness/tool-activation.js";
import { applyLastToolCacheBreakpoint, getAnthropicCacheMarker } from "#harness/prompt-cache.js";

function makeModel(provider: string, modelId: string): LanguageModel {
  return {
    provider,
    modelId,
    specificationVersion: "v4",
  } as LanguageModel;
}

function makeActivationTools() {
  const activationId = createToolActivationId("connection_search");
  const toModelOutput = vi.fn(
    async ({
      output,
    }: {
      readonly input: unknown;
      readonly output: JSONValue;
      readonly toolCallId: string;
    }) => ({
      type: "json" as const,
      value: output,
    }),
  );
  const loader = attachToolActivation(
    tool({
      description: "Search connection tools",
      execute: async () => [] as JSONValue,
      inputSchema: jsonSchema<Record<string, never>>({ type: "object" }),
      toModelOutput,
    }),
    {
      id: activationId,
      kind: "loader",
      project(output) {
        if (!Array.isArray(output)) return { tools: [] };
        return {
          tools: output.flatMap((item) => {
            if (
              item === null ||
              typeof item !== "object" ||
              typeof (item as { qualifiedName?: unknown }).qualifiedName !== "string" ||
              typeof (item as { description?: unknown }).description !== "string"
            ) {
              return [];
            }
            return [
              {
                description: (item as { description: string }).description,
                inputSchema: { type: "object" as const },
                name: (item as { qualifiedName: string }).qualifiedName,
              },
            ];
          }),
        };
      },
    },
  );
  const target = attachToolActivation(
    tool({
      description: "List issues",
      execute: async () => [] as JSONValue,
      inputSchema: jsonSchema<Record<string, never>>({ type: "object" }),
      providerOptions: {
        anthropic: { existing: true },
        openai: { strict: true },
      },
    }),
    { id: activationId, kind: "target" },
  );
  const tools = { connection_search: loader, linear__list_issues: target } satisfies ToolSet;

  return {
    loader,
    target,
    toModelOutput,
    tools,
  };
}

function requireToModelOutput(tools: ToolSet, name: string) {
  const toModelOutput = tools[name]?.toModelOutput;
  if (toModelOutput === undefined) throw new Error(`Missing toModelOutput for ${name}`);
  return toModelOutput;
}

describe("resolveToolActivationTransport", () => {
  it.each(["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4.8", "claude-fable-5"])(
    "uses Anthropic tool references for supported direct model %s",
    (modelId) => {
      expect(resolveToolActivationTransport(makeModel("anthropic.messages", modelId))).toBe(
        "anthropic-tool-reference",
      );
    },
  );

  it.each(["claude-opus-4-1", "claude-sonnet-3-7", "claude-3-5-haiku-latest"])(
    "keeps unsupported Anthropic model %s eager",
    (modelId) => {
      expect(resolveToolActivationTransport(makeModel("anthropic.messages", modelId))).toBe(
        "eager",
      );
    },
  );

  it("keeps Bedrock and Vertex adapters eager until their transport is proven", () => {
    expect(
      resolveToolActivationTransport(makeModel("bedrock.anthropic", "claude-sonnet-4-6")),
    ).toBe("eager");
    expect(resolveToolActivationTransport(makeModel("vertex.anthropic", "claude-sonnet-4-6"))).toBe(
      "eager",
    );
  });

  it("keeps Gateway model strings eager", () => {
    expect(resolveToolActivationTransport("anthropic/claude-sonnet-4.6")).toBe("eager");
    expect(resolveToolActivationTransport("openai/gpt-5.4")).toBe("eager");
  });
});

describe("applyProviderToolActivations", () => {
  it("marks targets deferred and emits Anthropic references after the loader result", async () => {
    const { loader, target, tools } = makeActivationTools();

    const result = applyProviderToolActivations({
      model: makeModel("anthropic.messages", "claude-sonnet-4-6"),
      tools,
    });

    expect(result).not.toBe(tools);
    expect(result.connection_search).not.toBe(loader);
    expect(result.linear__list_issues).not.toBe(target);
    expect(result.linear__list_issues?.providerOptions).toEqual({
      anthropic: { deferLoading: true, existing: true },
      openai: { strict: true },
    });

    const toModelOutput = requireToModelOutput(result, "connection_search");
    const output = [
      {
        connection: "linear",
        description: "List issues",
        inputSchema: { type: "object" },
        qualifiedName: "linear__list_issues",
        tool: "list_issues",
      },
      {
        connection: "github",
        description: "GitHub",
        error: "metadata unavailable",
      },
    ];

    expect(await toModelOutput({ input: {}, output, toolCallId: "call_search" })).toEqual({
      type: "content",
      value: [
        { text: JSON.stringify(output), type: "text" },
        {
          providerOptions: {
            anthropic: {
              toolName: "linear__list_issues",
              type: "tool-reference",
            },
          },
          type: "custom",
        },
      ],
    });
  });

  it("preserves the ordinary result when the loader introduces no tools", async () => {
    const { tools, toModelOutput: sourceToModelOutput } = makeActivationTools();
    const result = applyProviderToolActivations({
      model: makeModel("anthropic.messages", "claude-sonnet-4-6"),
      tools,
    });
    const toModelOutput = requireToModelOutput(result, "connection_search");
    const output = [{ connection: "github", description: "GitHub" }];

    expect(await toModelOutput({ input: {}, output, toolCallId: "call_search" })).toEqual({
      type: "json",
      value: output,
    });
    expect(sourceToModelOutput).toHaveBeenCalledOnce();
  });

  it("is a no-op for eager transports", () => {
    const { tools } = makeActivationTools();
    expect(
      applyProviderToolActivations({
        model: "anthropic/claude-sonnet-4.6",
        tools,
      }),
    ).toBe(tools);
  });

  it("serializes deferred definitions and references through the Anthropic adapter", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [{ text: "done", type: "text" }],
          id: "msg_test",
          model: "claude-sonnet-4-6",
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });
    const anthropic = createAnthropic({ apiKey: "test", fetch });
    const activationId = createToolActivationId("connection_search");
    const searchOutput = [
      {
        connection: "linear",
        description: "List issues",
        inputSchema: { type: "object" },
        qualifiedName: "linear__list_issues",
        tool: "list_issues",
      },
    ];
    const loader = attachToolActivation(
      tool({
        description: "Search connection tools",
        execute: async () => searchOutput,
        inputSchema: jsonSchema({ type: "object" }),
      }),
      {
        id: activationId,
        kind: "loader",
        project: () => ({
          tools: [
            {
              description: "List issues",
              inputSchema: { type: "object" },
              name: "linear__list_issues",
            },
          ],
        }),
      },
    );
    const target = attachToolActivation(
      tool({
        description: "List issues",
        execute: async () => [],
        inputSchema: jsonSchema({ type: "object" }),
      }),
      { id: activationId, kind: "target" },
    );
    const activated = applyProviderToolActivations({
      model: anthropic("claude-sonnet-4-6"),
      tools: { connection_search: loader, linear__list_issues: target },
    });
    const effectiveTools = applyLastToolCacheBreakpoint(activated, getAnthropicCacheMarker());
    const toModelOutput = requireToModelOutput(effectiveTools, "connection_search");
    const modelOutput = await toModelOutput({
      input: { keywords: "issues" },
      output: searchOutput,
      toolCallId: "call_search",
    });

    await generateText({
      maxOutputTokens: 16,
      messages: [
        { content: "Find an issue tool.", role: "user" },
        {
          content: [
            {
              input: { keywords: "issues" },
              toolCallId: "call_search",
              toolName: "connection_search",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              output: modelOutput as never,
              toolCallId: "call_search",
              toolName: "connection_search",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      model: anthropic("claude-sonnet-4-6"),
      tools: effectiveTools,
    });

    expect(requestBody?.tools).toEqual([
      {
        cache_control: { type: "ephemeral" },
        description: "Search connection tools",
        input_schema: { type: "object" },
        name: "connection_search",
      },
      {
        defer_loading: true,
        description: "List issues",
        input_schema: { type: "object" },
        name: "linear__list_issues",
      },
    ]);
    expect(requestBody?.messages).toEqual([
      {
        content: [{ text: "Find an issue tool.", type: "text" }],
        role: "user",
      },
      {
        content: [
          {
            id: "call_search",
            input: { keywords: "issues" },
            name: "connection_search",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            content: [
              { text: JSON.stringify(searchOutput), type: "text" },
              { tool_name: "linear__list_issues", type: "tool_reference" },
            ],
            tool_use_id: "call_search",
            type: "tool_result",
          },
        ],
        role: "user",
      },
    ]);
  });
});
