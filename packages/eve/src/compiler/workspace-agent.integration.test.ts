import { rmdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const rootConfig =
  "export default { model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n";
const peerConfig =
  "export default { description: 'Research product questions.', model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n";

function workspaceFiles(subagent: string) {
  return {
    // Workspace detection requires the root manifest to declare eve.
    "package.json": `${JSON.stringify({ dependencies: { eve: "*" }, name: "workspace", type: "module" })}\n`,
    "agents/research/agent/agent.ts": peerConfig,
    "agents/support/agent/agent.ts": rootConfig,
    "agents/support/agent/instructions.md": "Support users.\n",
    "agents/support/agent/subagents/research.ts": subagent,
  };
}

describe("Vercel workspace subagent compilation", () => {
  const createAppRoot = useTemporaryAppRoots();

  async function createWorkspace(prefix: string, subagent: string) {
    const app = await createAppRoot(prefix, { files: workspaceFiles(subagent) });
    // A root agent/ directory would make the workspace root an agent root.
    await rmdir(app.agentRoot);
    return app;
  }

  it("uses the addressed peer's description by default", async () => {
    const app = await createWorkspace(
      "eve-workspace-subagent-description-",
      [
        'import { defineWorkspaceAgent } from "eve";',
        'export default defineWorkspaceAgent({ name: "research" });',
        "",
      ].join("\n"),
    );

    const result = await compileAgent({ startPath: join(app.appRoot, "agents", "support") });
    expect(result.manifest.remoteAgents).toEqual([
      expect.objectContaining({ description: "Research product questions.", name: "research" }),
    ]);
  });

  it("uses an authored description override", async () => {
    const app = await createWorkspace(
      "eve-workspace-subagent-description-override-",
      [
        'import { defineWorkspaceAgent } from "eve";',
        "export default defineWorkspaceAgent({",
        '  description: "Research urgent support escalations.",',
        '  name: "research",',
        "});",
        "",
      ].join("\n"),
    );

    const result = await compileAgent({ startPath: join(app.appRoot, "agents", "support") });
    expect(result.manifest.remoteAgents).toEqual([
      expect.objectContaining({
        description: "Research urgent support escalations.",
        name: "research",
      }),
    ]);
  });

  it("rejects an unknown peer even with a description override", async () => {
    const app = await createWorkspace(
      "eve-workspace-subagent-unknown-peer-",
      [
        'import { defineWorkspaceAgent } from "eve";',
        "export default defineWorkspaceAgent({",
        '  description: "Research urgent support escalations.",',
        '  name: "missing",',
        "});",
        "",
      ].join("\n"),
    );

    await expect(
      compileAgent({ startPath: join(app.appRoot, "agents", "support") }),
    ).rejects.toThrow('targets unknown workspace member "missing"');
  });
});
