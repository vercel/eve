import { describe, expect, it } from "vitest";

import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { createAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { createProgrammaticModuleCandidates } from "#compiler/programmatic-module-candidates.js";

describe("defineProgrammaticAgentSource", () => {
  it("freezes containers without cloning definition values", () => {
    const marker = Symbol("definition");
    const definition = { execute: () => "ok", marker };
    const source = defineProgrammaticAgentSource({
      id: "eve.defaults",
      modules: [{ logicalPath: "tools/read_file.ts", namespace: { default: definition } }],
    });

    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.modules)).toBe(true);
    expect(Object.isFrozen(source.modules[0]?.namespace)).toBe(true);
    expect(source.modules[0]?.namespace.default).toBe(definition);
  });

  it.each(["/tools/read.ts", "../tools/read.ts", "tools//read.ts", "tools/read.txt"])(
    "rejects invalid module path %s",
    (logicalPath) => {
      expect(() =>
        defineProgrammaticAgentSource({
          id: "eve.invalid",
          modules: [{ logicalPath, namespace: {} }],
        }),
      ).toThrow();
    },
  );

  it("rejects duplicate paths", () => {
    expect(() =>
      defineProgrammaticAgentSource({
        id: "eve.duplicate",
        modules: [
          { logicalPath: "sandbox.ts", namespace: {} },
          { logicalPath: "sandbox.ts", namespace: {} },
        ],
      }),
    ).toThrow('declares "sandbox.ts" more than once');
  });
});

describe("programmatic source registration", () => {
  it("creates deterministic framework candidates for eligible nodes", () => {
    const source = defineProgrammaticAgentSource({
      id: "eve.defaults",
      modules: [{ logicalPath: "tools/read_file.ts", namespace: {} }],
    });
    const registry = createAgentSourceRegistry([{ applyTo: "all-local-nodes", source }]);

    expect(
      createProgrammaticModuleCandidates({ isRoot: false, nodeId: "subagents/research", registry }),
    ).toEqual([
      {
        backing: {
          kind: "programmatic",
          moduleId: "tools/read_file.ts",
          registryId: "eve.defaults",
        },
        layer: "framework-default",
        logicalPath: "tools/read_file.ts",
        nodeId: "subagents/research",
        owner: { feature: "eve.defaults", kind: "framework" },
        sourceId: "eve.defaults:tools/read_file.ts",
      },
    ]);
  });

  it("rejects graph-expanding all-node modules", () => {
    const source = defineProgrammaticAgentSource({
      id: "eve.invalid",
      modules: [{ logicalPath: "schedules/daily.ts", namespace: {} }],
    });
    expect(() => createAgentSourceRegistry([{ applyTo: "all-local-nodes", source }])).toThrow(
      "can expand the graph or host surface",
    );
  });
});
