import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { loadCompiledModuleMap } from "#runtime/loaders/module-map.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const strategy = (label: string) => `export default {
  [Symbol.for("eve:compaction-definition")]: true,
  label: ${JSON.stringify(label)},
  async compact(history) {
    return history;
  },
};
`;

const subagent = `export default { model: "openai/gpt-5.4", description: "Investigate one task." };\n`;

describe("subagent compaction", () => {
  it("uses the root strategy unless the subagent authors its own", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compaction-subagent-", {
      packageName: "compaction-subagent-agent",
    });
    await mkdir(join(agentRoot, "subagents", "inherits"), { recursive: true });
    await mkdir(join(agentRoot, "subagents", "owns"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), `export default { model: "openai/gpt-5.4" };\n`);
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise agent.\n");
    await writeFile(join(agentRoot, "compaction.mjs"), strategy("root"));
    for (const name of ["inherits", "owns"]) {
      await writeFile(join(agentRoot, "subagents", name, "agent.mjs"), subagent);
      await writeFile(join(agentRoot, "subagents", name, "instructions.md"), "Investigate.\n");
    }
    await writeFile(join(agentRoot, "subagents", "owns", "compaction.mjs"), strategy("own"));

    await compileAgent({ startPath: appRoot });
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMap({ compiledArtifactsSource }),
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    const labelOf = (nodeId: string) =>
      (graph.nodesByNodeId.get(nodeId)?.agent.compaction?.strategy as { label?: string })?.label;
    expect(labelOf("__root__")).toBe("root");
    expect(labelOf("subagents/inherits")).toBe("root");
    expect(labelOf("subagents/owns")).toBe("own");
  });
});
