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
const APP_ROOT_OPTIONS = { packageName: "hooks-scenario-agent" } as const;

/**
 * Pins the on-disk → bundle path: agent/hooks/** files compile, resolve,
 * and arrive on the runtime hook registry with live handlers attached.
 */

const AGENT_SOURCE = `export default { model: "openai/gpt-5.4" };\n`;

const AUDIT_HOOK_SOURCE = `export default {
  events: {
    async "turn.completed"() {},
    async "session.started"() {},
  },
};
`;

const METRICS_HOOK_SOURCE = `export default {
  events: {
    async "*"() {},
  },
};
`;

describe("authored hooks end-to-end", () => {
  it("compiles, resolves, and dispatches stream event hooks from disk", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-hooks-scenario-", APP_ROOT_OPTIONS);
    await mkdir(join(agentRoot, "hooks"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), AGENT_SOURCE);
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise agent.\n");
    await writeFile(join(agentRoot, "hooks", "audit.mjs"), AUDIT_HOOK_SOURCE);
    await writeFile(join(agentRoot, "hooks", "metrics.mjs"), METRICS_HOOK_SOURCE);

    await compileAgent({ startPath: appRoot });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMap({ compiledArtifactsSource }),
    ]);

    expect(manifest.hooks.map((entry) => entry.slug).sort()).toEqual(["audit", "metrics"]);

    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    const registry = graph.root.hookRegistry;

    expect(registry.streamEventsByType.get("turn.completed")?.map((e) => e.slug)).toEqual([
      "audit",
    ]);
    expect(registry.streamEventsByType.get("session.started")?.map((e) => e.slug)).toEqual([
      "audit",
    ]);
    expect(registry.streamEventsWildcard.map((e) => e.slug)).toEqual(["metrics"]);
  });

  it("rejects authored hook filenames that violate the hook charset at compile time", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-hooks-scenario-invalid-",
      APP_ROOT_OPTIONS,
    );
    await mkdir(join(agentRoot, "hooks"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), AGENT_SOURCE);
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise agent.\n");
    // Leading digit fails the segment charset rule.
    await writeFile(join(agentRoot, "hooks", "1bad.mjs"), AUDIT_HOOK_SOURCE);

    await expect(compileAgent({ startPath: appRoot })).rejects.toThrow(/hook/i);
  });

  it("isolates subagent hook registries from the parent", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-hooks-scenario-subagent-",
      APP_ROOT_OPTIONS,
    );
    await mkdir(join(agentRoot, "hooks"), { recursive: true });
    await mkdir(join(agentRoot, "subagents", "researcher", "hooks"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), AGENT_SOURCE);
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise agent.\n");
    await writeFile(join(agentRoot, "hooks", "audit.mjs"), AUDIT_HOOK_SOURCE);
    await writeFile(
      join(agentRoot, "subagents", "researcher", "agent.mjs"),
      `export default {
  model: "openai/gpt-5.4",
  description: "Investigate one task in depth.",
};
`,
    );
    await writeFile(
      join(agentRoot, "subagents", "researcher", "instructions.md"),
      "Investigate research tasks thoroughly.\n",
    );
    await writeFile(
      join(agentRoot, "subagents", "researcher", "hooks", "subagent-only.mjs"),
      METRICS_HOOK_SOURCE,
    );

    await compileAgent({ startPath: appRoot });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMap({ compiledArtifactsSource }),
    ]);

    expect(manifest.hooks.map((entry) => entry.slug)).toEqual(["audit"]);
    expect(manifest.subagents[0]?.agent.hooks.map((entry) => entry.slug)).toEqual([
      "subagent-only",
    ]);

    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    const subagentNode = graph.nodesByNodeId.get("subagents/researcher");
    if (subagentNode === undefined) throw new Error("expected the researcher node");

    expect(
      graph.root.hookRegistry.streamEventsByType.get("turn.completed")?.map((e) => e.slug),
    ).toEqual(["audit"]);
    expect(subagentNode.hookRegistry.streamEventsByType.size).toBe(0);
    expect(subagentNode.hookRegistry.streamEventsWildcard.map((e) => e.slug)).toEqual([
      "subagent-only",
    ]);
  });
});
