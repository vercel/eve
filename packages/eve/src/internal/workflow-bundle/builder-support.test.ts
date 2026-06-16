import { describe, expect, it } from "vitest";

import { createWorkflowNodeBuiltinGuardPlugin } from "#internal/workflow-bundle/builder-support.js";

describe("createWorkflowNodeBuiltinGuardPlugin", () => {
  const plugin = createWorkflowNodeBuiltinGuardPlugin();

  function resolve(source: string, importer?: string): unknown {
    return (plugin.resolveId as (s: string, i?: string) => unknown)(source, importer);
  }

  it("throws on a prefixed node: builtin and names the importer", () => {
    expect(() => resolve("node:util", "/app/src/execution/x.ts")).toThrow(
      /Node\.js builtin "node:util".*imported by "\/app\/src\/execution\/x\.ts".*use step/s,
    );
  });

  it("throws on a bare builtin specifier", () => {
    expect(() => resolve("fs")).toThrow(/Node\.js builtin "fs"/);
  });

  it("passes through non-builtin specifiers", () => {
    expect(resolve("#internal/logging.js")).toBeUndefined();
    expect(resolve("./sibling.js")).toBeUndefined();
    expect(resolve("eve")).toBeUndefined();
  });

  it("omits the importer clause when the importer is unknown", () => {
    expect(() => resolve("node:crypto")).toThrow(/Node\.js builtin "node:crypto"\. Move/);
  });
});
