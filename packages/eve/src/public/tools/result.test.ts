import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";

import type { RuntimeActionResult } from "#shared/action-types.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineTool } from "#tools/definition.js";
import { registerDefinitionSource } from "#internal/authored-definition/source-identity.js";
import {
  toolResultFrom,
  type MatchedConnectionResult,
  type MatchedToolResult,
} from "#public/tools/result.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function toolResult(toolName: string, output: unknown, isError?: boolean): RuntimeActionResult {
  const base: RuntimeActionResult = {
    callId: "call_1",
    kind: "tool-result",
    output: output as RuntimeActionResult extends { output: infer O } ? O : never,
    toolName,
  };
  if (isError !== undefined) {
    return { ...base, isError };
  }
  return base;
}

function subagentResult(): RuntimeActionResult {
  return {
    callId: "call_2",
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: "terminal",
      result: { kind: "succeeded", output: "done" },
      usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    },
    output: "done",
    subagentName: "sub",
  };
}

describe("toolResultFrom", () => {
  const weatherTool = defineTool({
    description: "Get the current weather for a city.",
    execute: async (): Promise<{ city: string; tempF: number }> => ({ city: "SF", tempF: 72 }),
    inputSchema: z.object({ city: z.string() }),
  });

  const linearConnection = defineMcpClientConnection({
    url: "https://mcp.linear.app",
    description: "Linear",
  });

  registerDefinitionSource(
    weatherTool,
    { kind: "tool", name: "get_weather" },
    "tool:Get the current weather for a city.",
  );
  registerDefinitionSource(
    linearConnection,
    { kind: "connection", name: "linear" },
    "connection:https://mcp.linear.app",
  );

  it("matches an authored tool result and returns typed output", () => {
    const result = toolResultFrom(
      toolResult("get_weather", { city: "SF", tempF: 72 }),
      weatherTool,
    );

    expect(result).toEqual({
      callId: "call_1",
      output: { city: "SF", tempF: 72 },
      toolName: "get_weather",
    });

    if (result !== undefined) {
      const _check: MatchedToolResult<{ city: string; tempF: number }> = result;
      void _check;
    }
  });

  it("preserves structured output — not a JSON string", () => {
    const structured = { city: "SF", tempF: 72, nested: { wind: "calm" } };
    const result = toolResultFrom(toolResult("get_weather", structured), weatherTool);

    expect(result).toBeDefined();
    expect(typeof result!.output).toBe("object");
    expect(result!.output).toEqual(structured);
  });

  it("returns undefined when tool name does not match", () => {
    const result = toolResultFrom(toolResult("other_tool", {}), weatherTool);
    expect(result).toBeUndefined();
  });

  it("returns undefined when definition key was never registered", () => {
    const unregistered = defineTool({
      description: "A tool whose key was never registered by resolution.",
      execute: async () => ({}),
      inputSchema: z.object({}),
    });
    const result = toolResultFrom(toolResult("unregistered", {}), unregistered);
    expect(result).toBeUndefined();
  });

  it("returns undefined when result is not a tool-result", () => {
    const result = toolResultFrom(subagentResult(), weatherTool);
    expect(result).toBeUndefined();
  });

  it("returns undefined when isError is true", () => {
    const result = toolResultFrom(toolResult("get_weather", "something failed", true), weatherTool);
    expect(result).toBeUndefined();
  });

  it("works across module instances — key matches even without object identity", () => {
    const copy = defineTool({
      description: "Get the current weather for a city.",
      execute: async (): Promise<{ city: string; tempF: number }> => ({ city: "NY", tempF: 65 }),
      inputSchema: z.object({ city: z.string() }),
    });

    expect(copy).not.toBe(weatherTool);

    const result = toolResultFrom(toolResult("get_weather", { city: "NY", tempF: 65 }), copy);
    expect(result).toBeDefined();
    expect(result!.output).toEqual({ city: "NY", tempF: 65 });
  });

  it("uses loaded definitions to distinguish tools with the same description", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = defineTool({
      description: "Run the shared action.",
      execute: async (): Promise<{ source: "first" }> => ({ source: "first" }),
      inputSchema: z.object({}),
    });
    const second = defineTool({
      description: "Run the shared action.",
      execute: async (): Promise<{ source: "second" }> => ({ source: "second" }),
      inputSchema: z.object({}),
    });

    registerDefinitionSource(
      first,
      { kind: "tool", logicalPath: "tools/first.ts", name: "first_tool" },
      "tool:Run the shared action.",
    );
    registerDefinitionSource(
      second,
      { kind: "tool", logicalPath: "tools/second.ts", name: "second_tool" },
      "tool:Run the shared action.",
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'eve could not assign a unique toolResultFrom identity for "tool:Run the shared action."',
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Conflicting definitions: tool "first_tool" from "tools/first.ts" and tool "second_tool" from "tools/second.ts".',
      ),
    );
    expect(toolResultFrom(toolResult("first_tool", { source: "first" }), first)).toEqual({
      callId: "call_1",
      output: { source: "first" },
      toolName: "first_tool",
    });
    expect(toolResultFrom(toolResult("first_tool", { source: "first" }), second)).toBeUndefined();
  });

  it("does not use a colliding description fallback to narrow the wrong tool", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const copy = defineTool({
      description: "Run the fallback action.",
      execute: async (): Promise<{ source: string }> => ({ source: "copy" }),
      inputSchema: z.object({}),
    });

    registerDefinitionSource(
      {},
      { kind: "tool", logicalPath: "tools/first.ts", name: "first_tool" },
      "tool:Run the fallback action.",
    );
    registerDefinitionSource(
      {},
      { kind: "tool", logicalPath: "tools/second.ts", name: "second_tool" },
      "tool:Run the fallback action.",
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(toolResultFrom(toolResult("first_tool", { source: "first" }), copy)).toBeUndefined();
  });

  it("matches a connection tool result with qualified name", () => {
    const result = toolResultFrom(toolResult("linear__list_issues", [{ id: 1 }]), linearConnection);

    expect(result).toEqual({
      callId: "call_1",
      connectionToolName: "list_issues",
      output: [{ id: 1 }],
      toolName: "linear__list_issues",
    });

    if (result !== undefined) {
      const _check: MatchedConnectionResult = result;
      void _check;
    }
  });

  it("returns undefined when connection prefix does not match", () => {
    const result = toolResultFrom(toolResult("github__list_repos", []), linearConnection);
    expect(result).toBeUndefined();
  });

  it("uses loaded definitions to distinguish connections with the same URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = defineMcpClientConnection({
      url: "https://mcp.example.test",
      description: "First",
    });
    const second = defineMcpClientConnection({
      url: "https://mcp.example.test",
      description: "Second",
    });

    registerDefinitionSource(
      first,
      { kind: "connection", logicalPath: "connections/first.ts", name: "first" },
      "connection:https://mcp.example.test",
    );
    registerDefinitionSource(
      second,
      { kind: "connection", logicalPath: "connections/second.ts", name: "second" },
      "connection:https://mcp.example.test",
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'eve could not assign a unique toolResultFrom identity for "connection:https://mcp.example.test"',
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Conflicting definitions: connection "first" from "connections/first.ts" and connection "second" from "connections/second.ts".',
      ),
    );
    expect(toolResultFrom(toolResult("first__search", []), first)).toEqual({
      callId: "call_1",
      connectionToolName: "search",
      output: [],
      toolName: "first__search",
    });
    expect(toolResultFrom(toolResult("first__search", []), second)).toBeUndefined();
  });
});
