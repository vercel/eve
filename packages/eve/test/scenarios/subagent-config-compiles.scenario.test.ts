import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

// Exercises the full disk discover -> compile pipeline and asserts a directory
// subagent's authored config (model, name, description) survives compilation
// rather than collapsing to an empty object.
describe("subagent config compiles through discovery", () => {
  it("populates a directory subagent's compiled config", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-repro-subagent-", {
      packageName: "repro-agent",
    });

    const subagentRoot = join(agentRoot, "subagents", "past-appearances");
    await mkdir(subagentRoot, { recursive: true });

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a coordinator.\n");
    await writeFile(
      join(subagentRoot, "agent.mjs"),
      'export default { model: "openai/gpt-5.4", description: "Find past appearances." };\n',
    );
    await writeFile(join(subagentRoot, "instructions.md"), "Find past appearances.\n");

    const result = await compileAgent({ startPath: appRoot });

    expect(result.manifest.subagents).toHaveLength(1);
    expect(result.manifest.subagents[0]).toMatchObject({
      name: "past-appearances",
      nodeId: "subagents/past-appearances",
      sourceId: "subagents/past-appearances",
    });
    expect(result.manifest.subagents[0]?.agent.config).toMatchObject({
      name: "past-appearances",
      description: "Find past appearances.",
      model: {
        id: "openai/gpt-5.4",
        contextWindowTokens: expect.any(Number),
      },
    });
  });

  it("populates compiled config for every subagent when multiple are authored", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-repro-multi-subagent-", {
      packageName: "repro-agent",
    });

    const researcherRoot = join(agentRoot, "subagents", "researcher");
    const reviewerRoot = join(agentRoot, "subagents", "reviewer");
    await mkdir(researcherRoot, { recursive: true });
    await mkdir(reviewerRoot, { recursive: true });

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a coordinator.\n");
    await writeFile(
      join(researcherRoot, "agent.mjs"),
      'export default { model: "openai/gpt-5.4", description: "Research topics in depth." };\n',
    );
    await writeFile(join(researcherRoot, "instructions.md"), "Research topics in depth.\n");
    await writeFile(
      join(reviewerRoot, "agent.mjs"),
      'export default { model: "openai/gpt-5.4", description: "Review drafted content." };\n',
    );
    await writeFile(join(reviewerRoot, "instructions.md"), "Review drafted content.\n");

    const result = await compileAgent({ startPath: appRoot });

    expect(result.manifest.subagents).toHaveLength(2);

    const byName = new Map(result.manifest.subagents.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(["researcher", "reviewer"]);

    expect(byName.get("researcher")?.agent.config).toMatchObject({
      name: "researcher",
      description: "Research topics in depth.",
      model: { id: "openai/gpt-5.4", contextWindowTokens: expect.any(Number) },
    });
    expect(byName.get("reviewer")?.agent.config).toMatchObject({
      name: "reviewer",
      description: "Review drafted content.",
      model: { id: "openai/gpt-5.4", contextWindowTokens: expect.any(Number) },
    });
  });
});
