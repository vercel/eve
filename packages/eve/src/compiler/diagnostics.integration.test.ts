import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CompilerDiagnostic } from "#compiler/diagnostics.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

describe("code mode's untyped tools", () => {
  const createAppRoot = useTemporaryAppRoots();

  it("warns about the tools of the subagent with code mode on, not its parent's", async () => {
    const untypedTool = [
      "import { defineTool } from 'eve/tools';",
      "export default defineTool({",
      "  description: 'Looks something up.',",
      "  inputSchema: { type: 'object' },",
      "  execute: () => null,",
      "});",
    ].join("\n");
    const app = await createAppRoot("eve-code-mode-untyped-tools-", {
      files: {
        "agent/tools/lookup.ts": untypedTool,
        "agent/subagents/researcher/agent.ts": [
          "import { defineAgent } from 'eve';",
          "export default defineAgent({",
          "  codeMode: true,",
          "  description: 'Researches questions.',",
          "  model: 'openai/gpt-5.4',",
          "});",
        ].join("\n"),
        "agent/subagents/researcher/tools/search_notes.ts": untypedTool,
      },
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const diagnostics: CompilerDiagnostic[] = [];

    await compileAgentManifest(discovered.manifest, { diagnostics });

    expect(diagnostics.filter(({ code }) => code === "compile/code-mode-untyped-tool")).toEqual([
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            nodeId: "subagents/researcher",
            sourcePath: expect.stringMatching(/search_notes\.ts$/u),
          }),
        ],
      }),
    ]);
  });
});
