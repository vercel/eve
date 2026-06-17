import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";

import type { RuntimeActionResult } from "#runtime/actions/types.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineTool } from "#public/definitions/tool.js";
import {
  toolResultFrom,
  registerDefinitionSource,
  stampDefinitionKey,
  type MatchedConnectionResult,
  type MatchedToolResult,
} from "#public/tool-result-narrowing.js";

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
  return { callId: "call_2", kind: "subagent-result", output: "done", subagentName: "sub" };
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

  registerDefinitionSource("tool:Get the current weather for a city.", {
    kind: "tool",
    name: "get_weather",
  });
  registerDefinitionSource("connection:https://mcp.linear.app", {
    kind: "connection",
    name: "linear",
  });

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

  it("uses source-derived keys to distinguish tools with the same description", () => {
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

    stampDefinitionKey(first, "tool-source:first-source");
    stampDefinitionKey(second, "tool-source:second-source");
    registerDefinitionSource("tool-source:first-source", {
      kind: "tool",
      logicalPath: "tools/first.ts",
      name: "first_tool",
    });
    registerDefinitionSource("tool-source:second-source", {
      kind: "tool",
      logicalPath: "tools/second.ts",
      name: "second_tool",
    });
    registerDefinitionSource("tool:Run the shared action.", {
      kind: "tool",
      logicalPath: "tools/first.ts",
      name: "first_tool",
    });
    registerDefinitionSource("tool:Run the shared action.", {
      kind: "tool",
      logicalPath: "tools/second.ts",
      name: "second_tool",
    });

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

    registerDefinitionSource("tool:Run the fallback action.", {
      kind: "tool",
      logicalPath: "tools/first.ts",
      name: "first_tool",
    });
    registerDefinitionSource("tool:Run the fallback action.", {
      kind: "tool",
      logicalPath: "tools/second.ts",
      name: "second_tool",
    });

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

  it("uses source-derived keys to distinguish connections with the same URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = defineMcpClientConnection({
      url: "https://mcp.example.test",
      description: "First",
    });
    const second = defineMcpClientConnection({
      url: "https://mcp.example.test",
      description: "Second",
    });

    stampDefinitionKey(first, "connection-source:first-source");
    stampDefinitionKey(second, "connection-source:second-source");
    registerDefinitionSource("connection-source:first-source", {
      kind: "connection",
      logicalPath: "connections/first.ts",
      name: "first",
    });
    registerDefinitionSource("connection-source:second-source", {
      kind: "connection",
      logicalPath: "connections/second.ts",
      name: "second",
    });
    registerDefinitionSource("connection:https://mcp.example.test", {
      kind: "connection",
      logicalPath: "connections/first.ts",
      name: "first",
    });
    registerDefinitionSource("connection:https://mcp.example.test", {
      kind: "connection",
      logicalPath: "connections/second.ts",
      name: "second",
    });

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
