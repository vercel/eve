import { describe, expect, it } from "vitest";

import type { AgentModuleCandidate } from "#compiler/agent-module-candidate.js";
import {
  canonicalModuleSlot,
  composeAgentModuleCandidates,
} from "#compiler/compose-agent-module-candidates.js";

function candidate(
  layer: AgentModuleCandidate["layer"],
  logicalPath: string,
): AgentModuleCandidate {
  return {
    backing: {
      externalDependencies: [],
      kind: "filesystem",
      sourcePath: `/physical/${layer}/${logicalPath}`,
    },
    layer,
    logicalPath,
    nodeId: "__root__",
    owner: { kind: "application" },
    sourceId: `${layer}:${logicalPath}`,
  };
}

describe("composeAgentModuleCandidates", () => {
  it("selects one winner by the global layer order", () => {
    const candidates = [
      candidate("application", "tools/search.js"),
      candidate("framework-default", "tools/search.ts"),
      candidate("extension-override", "tools/search.mts"),
      candidate("extension-package", "tools/search.cjs"),
    ];
    const result = composeAgentModuleCandidates(candidates);

    expect(result.winners).toEqual([candidates[0]]);
    expect(result.entries[0]?.candidates.map((entry) => entry.layer)).toEqual([
      "framework-default",
      "extension-package",
      "extension-override",
      "application",
    ]);
  });

  it("rejects same-layer aliases before loading either candidate", () => {
    expect(() =>
      composeAgentModuleCandidates([
        candidate("application", "connections/linear.ts"),
        candidate("application", "connections/linear/connection.js"),
      ]),
    ).toThrow("duplicate application candidates");
  });
});

describe("canonicalModuleSlot", () => {
  it.each([
    ["tools/read.ts", "tools/read"],
    ["connections/linear/connection.mjs", "connections/linear"],
    ["sandbox/sandbox.ts", "sandbox"],
  ])("maps %s to %s", (logicalPath, expected) => {
    expect(canonicalModuleSlot(logicalPath)).toBe(expected);
  });
});
