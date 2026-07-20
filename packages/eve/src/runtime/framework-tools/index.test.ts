import { describe, expect, it } from "vitest";

import {
  getAllFrameworkToolDefinitions,
  getAllFrameworkToolNames,
  getFrameworkToolDefinitions,
} from "#runtime/framework-tools/index.js";
import { isToolSchema } from "#shared/tool-schema.js";

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
    expect(names.has("agent")).toBe(true);
    // connection_search is now a dynamic tool resolver, not a framework tool
    expect(names.has("connection_search")).toBe(false);
  });

  it("contains every framework tool exactly once", () => {
    const tools = getAllFrameworkToolDefinitions();
    const names = tools.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.name.length).toBeGreaterThan(0);
    }

    expect(names).toContain("agent");
    expect(getFrameworkToolDefinitions().map((tool) => tool.name)).not.toContain("agent");
  });

  it("uses one validated runtime schema for every framework-defined input", () => {
    for (const tool of getAllFrameworkToolDefinitions()) {
      if (tool.inputSchema !== null) {
        expect(isToolSchema(tool.inputSchema), `${tool.name} has a validated input schema`).toBe(
          true,
        );
      }
    }
  });

  it("declares an output schema for every statically shaped registered tool", () => {
    const tools = getFrameworkToolDefinitions();
    for (const tool of tools) {
      if (tool.name === "web_search") {
        expect(tool.outputSchema).toBeUndefined();
        continue;
      }

      expect(tool.outputSchema, `${tool.name} has outputSchema`).toBeDefined();
    }
  });

  it("returns the same registered tools regardless of hasConnections", () => {
    const withConnections = getFrameworkToolDefinitions({ hasConnections: true });
    const withoutConnections = getFrameworkToolDefinitions({ hasConnections: false });

    expect(withConnections.map((tool) => tool.name)).toEqual(
      withoutConnections.map((tool) => tool.name),
    );
  });
});
