import { type JSONSchema7, jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { always, never, once } from "#public/tools/approval/approval-helpers.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_GATEWAY_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
} from "#runtime/framework-tools/web-search.js";
import type { JsonObject } from "#shared/json.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildToolSet, buildToolSetWithProviderTools } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";

function getJsonSchema(tool: unknown): unknown {
  return (tool as { inputSchema: { jsonSchema: unknown } }).inputSchema.jsonSchema;
}

function getOutputJsonSchema(tool: unknown): unknown {
  return (tool as { outputSchema: { jsonSchema: unknown } }).outputSchema.jsonSchema;
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
    [{ id: "openai/gpt-5.4" }, WEB_SEARCH_OPENAI_OUTPUT_SCHEMA],
    [{ id: "anthropic/claude-opus-4.6" }, WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA],
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
    [{ id: "mistral/mistral-large" }, WEB_SEARCH_GATEWAY_OUTPUT_SCHEMA],
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

  it("defaults to no approval when no needsApproval function is set", async () => {
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

    const needsApproval = (
      result.dangerous_tool as {
        needsApproval?: (input: unknown, context: unknown) => Promise<boolean> | boolean;
      }
    ).needsApproval;

    expect(needsApproval).toBeTypeOf("function");
    await expect(needsApproval?.({}, {})).resolves.toBe(false);
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

  describe("tool-level needsApproval override", () => {
    type NeedsApprovalFn = (input: unknown, context: unknown) => Promise<boolean> | boolean;

    it("always() requires approval", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "bash",
          {
            description: "Run a command.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "bash",
            needsApproval: always(),
          },
        ],
      ]);

      const result = buildToolSet({
        tools,
      });
      const needsApproval = (result.bash as { needsApproval?: NeedsApprovalFn }).needsApproval;
      await expect(needsApproval?.({}, {})).resolves.toBe(true);
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
            needsApproval: never(),
          },
        ],
      ]);

      const result = buildToolSet({
        tools,
      });
      const needsApproval = (result.bash as { needsApproval?: NeedsApprovalFn }).needsApproval;
      await expect(needsApproval?.({}, {})).resolves.toBe(false);
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
            needsApproval: once(),
          },
        ],
      ]);

      const result = buildToolSet({
        tools,
      });
      const needsApproval = (result.bash as { needsApproval?: NeedsApprovalFn }).needsApproval;
      await expect(needsApproval?.({}, {})).resolves.toBe(true);
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
            needsApproval: once(),
          },
        ],
      ]);

      const result = buildToolSet({
        approvedTools: new Set(["bash"]),
        tools,
      });
      const needsApproval = (result.bash as { needsApproval?: NeedsApprovalFn }).needsApproval;
      await expect(needsApproval?.({}, {})).resolves.toBe(false);
    });

    it("tool without needsApproval defaults to false when another tool has an override", async () => {
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "bash",
          {
            description: "Run a command.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "bash",
            needsApproval: always(),
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
      const bashNeedsApproval = (result.bash as { needsApproval?: NeedsApprovalFn }).needsApproval;
      const writeNeedsApproval = (result.write_file as { needsApproval?: NeedsApprovalFn })
        .needsApproval;
      await expect(bashNeedsApproval?.({}, {})).resolves.toBe(true);
      await expect(writeNeedsApproval?.({}, {})).resolves.toBe(false);
    });

    it("passes toolInput from the AI SDK into needsApproval", async () => {
      let capturedInput: unknown;
      const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
        [
          "vercel__list_projects",
          {
            description: "List projects in the team.",
            execute: async () => "ok",
            inputSchema: jsonSchema({}),
            name: "vercel__list_projects",
            needsApproval: (ctx) => {
              capturedInput = ctx.toolInput;
              return true;
            },
          },
        ],
      ]);

      const result = buildToolSet({ tools });
      const needsApproval = (result.vercel__list_projects as { needsApproval?: NeedsApprovalFn })
        .needsApproval;

      const toolInput = { teamId: "team_abc", limit: 20 };
      await needsApproval?.(toolInput, {});

      expect(capturedInput).toEqual(toolInput);
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
            needsApproval: ({ approvedTools, toolName, toolInput }) => {
              if (approvedTools.has(toolName)) return false;
              const team = (toolInput as { teamId?: string } | undefined)?.teamId;
              if (team === undefined) return true;
              return !approvedTools.has(`${toolName}:${team}`);
            },
          },
        ],
      ]);

      const withCompoundKey = buildToolSet({
        approvedTools: new Set(["vercel__list_projects:team_abc"]),
        tools,
      });
      const needsApproval = (
        withCompoundKey.vercel__list_projects as { needsApproval?: NeedsApprovalFn }
      ).needsApproval;

      await expect(needsApproval?.({ teamId: "team_abc", limit: 10 }, {})).resolves.toBe(false);

      await expect(needsApproval?.({ teamId: "team_xyz", limit: 10 }, {})).resolves.toBe(true);
    });
  });
});
