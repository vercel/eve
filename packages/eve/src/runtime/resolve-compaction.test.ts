import { describe, expect, it } from "vitest";

import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledCompactionDefinition,
} from "../compiler/manifest.js";
import type { CompiledModuleMap } from "../compiler/module-map.js";
import { defineCompaction } from "../public/compaction/index.js";
import { resolveCompactionDefinition } from "./resolve-compaction.js";

const compiled: CompiledCompactionDefinition = {
  exportName: undefined,
  logicalPath: "compaction.ts",
  sourceId: "compaction.ts",
  sourceKind: "module",
};

function buildModuleMap(moduleNamespace: unknown): CompiledModuleMap {
  return {
    nodes: { [ROOT_COMPILED_AGENT_NODE_ID]: { modules: { [compiled.sourceId]: moduleNamespace } } },
  } as CompiledModuleMap;
}

describe("resolveCompactionDefinition", () => {
  it("resolves the authored strategy with its source ref", async () => {
    const strategy = defineCompaction({
      async compact() {
        return [];
      },
      shouldCompact: () => false,
    });

    const resolved = await resolveCompactionDefinition(
      compiled,
      buildModuleMap({ default: strategy }),
      undefined,
    );

    expect(resolved.strategy).toBe(strategy);
    expect(resolved).toMatchObject({ logicalPath: "compaction.ts", sourceKind: "module" });
  });

  it("rejects an export not created with defineCompaction()", async () => {
    await expect(
      resolveCompactionDefinition(
        compiled,
        buildModuleMap({ default: { compact() {}, shouldCompact: () => true } }),
        undefined,
      ),
    ).rejects.toThrow("to be created with defineCompaction()");
  });
});
