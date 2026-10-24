import { describe, expect, it } from "vitest";

import { discoverCompactionSource } from "#discover/compaction.js";
import { DISCOVER_MODULE_SLOT_COLLISION, readSortedDirectoryEntries } from "#discover/grammar.js";
import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";

async function discover(agentFiles: Record<string, string>) {
  const project = buildMemoryAgentProject({ agentFiles });
  const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
  return discoverCompactionSource({ rootEntries, rootPath: project.agentRoot });
}

describe("discoverCompactionSource", () => {
  it("returns null when the agent has no compaction module", async () => {
    const result = await discover({ "instructions.md": "" });

    expect(result.diagnostics).toEqual([]);
    expect(result.compaction).toBeNull();
  });

  it("discovers a flat compaction module at the agent root", async () => {
    const result = await discover({ "compaction.ts": "export default {};\n" });

    expect(result.diagnostics).toEqual([]);
    expect(result.compaction).toEqual({
      logicalPath: "compaction.ts",
      sourceId: "compaction.ts",
      sourceKind: "module",
    });
  });

  it("reports ambiguous compaction modules", async () => {
    const result = await discover({
      "compaction.mjs": "export default {};\n",
      "compaction.ts": "export default {};\n",
    });

    expect(result.compaction).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_MODULE_SLOT_COLLISION,
    ]);
  });
});
