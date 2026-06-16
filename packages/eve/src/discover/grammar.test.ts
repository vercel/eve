import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "../internal/testing/memory-agent-source.js";
import { discoverNamedSourceDirectory, readSortedDirectoryEntries } from "./grammar.js";

/**
 * Direct coverage for the unified discovery helper. The channels, tools,
 * hooks, lib, instructions layer, and schedule slots are exercised end-to-end
 * through `discoverAgent` in `agent.integration.test.ts`; this file pins
 * the helper's API contract for the recursive-walk shape, the
 * missing-directory shape, the markdown-or-module fork, and the slot
 * collision behavior.
 */
describe("discoverNamedSourceDirectory", () => {
  it("walks recursively and emits modules in depth-first, alphabetical order", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "hooks/audit.ts": "export default {};\n",
        "hooks/auth/guard.ts": "export default {};\n",
        "hooks/auth/prepare.ts": "export default {};\n",
        "hooks/zzz/last.ts": "export default {};\n",
        "instructions.md": "",
      },
    });
    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);

    const result = await discoverNamedSourceDirectory({
      directoryName: "hooks",
      invalidDirectoryCode: "test/invalid",
      invalidDirectoryMessage: "expected hooks/ to be a directory",
      recursive: true,
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sources.map((source) => source.logicalPath)).toEqual([
      "hooks/auth/guard.ts",
      "hooks/auth/prepare.ts",
      "hooks/zzz/last.ts",
      "hooks/audit.ts",
    ]);
  });

  it("returns an empty result when the named directory is missing", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "",
      },
    });
    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);

    const result = await discoverNamedSourceDirectory({
      directoryName: "hooks",
      invalidDirectoryCode: "test/invalid",
      invalidDirectoryMessage: "should not appear",
      recursive: true,
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it("lowers markdown leaves through `markdownLowerer` when allowed", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "",
        "schedules/intro.MD": "Always greet the user.",
        "schedules/tools.ts": "export default { markdown: () => 'Use tools.' };",
      },
    });
    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);

    const result = await discoverNamedSourceDirectory({
      allowMarkdown: true,
      directoryName: "schedules",
      invalidDirectoryCode: "test/invalid",
      invalidDirectoryMessage: "expected schedules/ to be a directory",
      markdownLowerer: (markdown) => ({ markdown }),
      recursive: true,
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sources.map((source) => source.logicalPath)).toEqual([
      "schedules/intro.MD",
      "schedules/tools.ts",
    ]);
    const [intro] = result.sources;
    expect(intro?.sourceKind).toBe("markdown");
    if (intro?.sourceKind === "markdown") {
      expect(intro.definition).toEqual({ markdown: "Always greet the user." });
    }
  });

  it("emits DISCOVER_SLOT_COLLISION when a slot has both markdown and module sources", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "",
        "schedules/intro.md": "from md",
        "schedules/intro.ts": "export default { markdown: 'from ts' };",
      },
    });
    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);

    const result = await discoverNamedSourceDirectory({
      allowMarkdown: true,
      directoryName: "schedules",
      invalidDirectoryCode: "test/invalid",
      invalidDirectoryMessage: "should not appear",
      markdownLowerer: (markdown) => ({ markdown }),
      recursive: true,
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.sources).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("discover/slot-collision");
  });

  it("emits the configured unsupported-file diagnostic when a non-module non-markdown leaf appears", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "",
        "lib/helpers.ts": "export const x = 1;",
        "lib/notes.txt": "stray file",
      },
    });
    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);

    const result = await discoverNamedSourceDirectory({
      directoryName: "lib",
      invalidDirectoryCode: "test/invalid",
      invalidDirectoryMessage: "should not appear",
      recursive: true,
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
      unsupportedFileCode: "test/lib-file-unsupported",
      unsupportedFileMessage: (sourcePath) => `bad lib leaf: ${sourcePath}`,
    });

    expect(result.sources.map((source) => source.logicalPath)).toEqual(["lib/helpers.ts"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("test/lib-file-unsupported");
  });

  it("silently ignores unrecognized leaves when no unsupported-file code is configured", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "",
        "tools/get_weather.ts": "export default {};",
        "tools/notes.txt": "stray file",
      },
    });
    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);

    const result = await discoverNamedSourceDirectory({
      directoryName: "tools",
      invalidDirectoryCode: "test/invalid",
      invalidDirectoryMessage: "should not appear",
      recursive: false,
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sources.map((source) => source.logicalPath)).toEqual(["tools/get_weather.ts"]);
  });
});
