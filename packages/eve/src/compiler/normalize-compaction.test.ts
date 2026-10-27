import { describe, expect, it } from "vitest";

import { compileCompactionDefinition } from "#compiler/normalize-compaction.js";
import type { AgentModuleBinding } from "#compiler/source-graph.js";
import { normalizeCompactionDefinition } from "#internal/authored-definition/compaction.js";
import { defineCompaction } from "#public/compaction/index.js";

const message = "Invalid compaction definition.";

function createStrategy() {
  return {
    async compact() {
      return [];
    },
  };
}

const source = {
  logicalPath: "compaction.ts",
  sourceId: "compaction.ts",
  sourceKind: "module" as const,
};
const binding = { logicalPath: "compaction.ts" } as AgentModuleBinding;

function compile(exported: unknown) {
  return compileCompactionDefinition(source, {
    binding,
    loadNamespace: async () => ({ default: exported }),
  });
}

describe("normalizeCompactionDefinition", () => {
  it("accepts a defineCompaction() strategy", () => {
    const definition = defineCompaction(createStrategy());

    expect(normalizeCompactionDefinition(definition, message)).toBe(definition);
  });

  it("rejects a plain strategy that was not created with defineCompaction()", () => {
    expect(() => normalizeCompactionDefinition(createStrategy(), message)).toThrow(message);
  });

  it("rejects a defined export missing a strategy method", () => {
    const definition = defineCompaction(createStrategy());
    Reflect.deleteProperty(definition, "compact");

    expect(() => normalizeCompactionDefinition(definition, message)).toThrow(
      `${message} "compact" must be a function.`,
    );
  });
});

describe("compileCompactionDefinition", () => {
  it("compiles a defined export to its module source ref", async () => {
    await expect(compile(defineCompaction(createStrategy()))).resolves.toEqual({
      exportName: undefined,
      logicalPath: "compaction.ts",
      sourceId: "compaction.ts",
      sourceKind: "module",
    });
  });

  it("rejects a non-defined export with a pointer to defineCompaction()", async () => {
    await expect(compile(createStrategy())).rejects.toThrow(
      'Expected the compaction export "default" from "compaction.ts" to be created with defineCompaction().',
    );
  });
});
