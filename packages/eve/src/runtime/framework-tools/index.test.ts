import { describe, expect, it } from "vitest";

import {
  getAllFrameworkToolNames,
  getFrameworkToolDefinitions,
} from "#runtime/framework-tools/index.js";

describe("framework-tools/index", () => {
  it("returns every known framework tool name regardless of config", () => {
    const names = getAllFrameworkToolNames();
    expect(names.has("bash")).toBe(true);
    expect(names.has("read_file")).toBe(true);
    expect(names.has("write_file")).toBe(true);
    expect(names.has("glob")).toBe(true);
    expect(names.has("grep")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
    expect(names.has("todo")).toBe(true);
    expect(names.has("load_skill")).toBe(true);
    expect(names.has("ask_question")).toBe(true);
    // connection_search is now a dynamic tool resolver, not a framework tool
    expect(names.has("connection_search")).toBe(false);
  });

  it("never returns undefined entries", () => {
    for (const config of [{ hasConnections: true }, { hasConnections: false }] as const) {
      const tools = getFrameworkToolDefinitions(config);
      for (const tool of tools) {
        expect(tool, `framework tool entry is undefined`).toBeDefined();
        expect(tool.name).toBeTypeOf("string");
        expect(tool.name.length).toBeGreaterThan(0);
      }
    }
  });

  it("declares an output schema for every statically shaped framework tool", () => {
    const tools = getFrameworkToolDefinitions();
    for (const tool of tools) {
      if (tool.name === "web_search") {
        expect(tool.outputSchema).toBeUndefined();
        continue;
      }

      expect(tool.outputSchema, `${tool.name} has outputSchema`).toBeDefined();
    }
  });

  it("returns the same tools regardless of hasConnections", () => {
    const withConnections = getFrameworkToolDefinitions({ hasConnections: true });
    const withoutConnections = getFrameworkToolDefinitions({ hasConnections: false });
    expect(withConnections.map((t) => t.name)).toEqual(withoutConnections.map((t) => t.name));
  });
});
