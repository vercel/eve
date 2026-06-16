import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { DISCOVER_MODULE_SLOT_COLLISION } from "#discover/grammar.js";
import {
  DISCOVER_SANDBOX_DIRECTORY_INVALID,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import {
  DISCOVER_SANDBOX_FOLDER_EMPTY,
  DISCOVER_SANDBOX_WORKSPACE_SKILLS_RESERVED,
  discoverSandboxSource,
} from "#discover/sandbox.js";

describe("discoverSandboxSource (memory)", () => {
  it("returns no entries when the agent has no sandbox/ folder", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sandbox).toBeNull();
    expect(result.sandboxWorkspace).toBeNull();
  });

  it("discovers a sandbox module without a workspace folder", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "sandbox/sandbox.ts": "export default {};\n",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sandbox).toEqual({
      sourceKind: "module",
      logicalPath: "sandbox/sandbox.ts",
      sourceId: "sandbox/sandbox.ts",
    });
    expect(result.sandboxWorkspace).toBeNull();
  });

  it("discovers a workspace folder without a sandbox module", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "sandbox/workspace/notes.md": "seed",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sandbox).toBeNull();
    expect(result.sandboxWorkspace).not.toBeNull();
    expect(result.sandboxWorkspace?.logicalPath).toBe("sandbox/workspace");
    expect(result.sandboxWorkspace?.rootEntries).toEqual(["notes.md"]);
  });

  it("discovers both a sandbox module and a workspace folder", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "sandbox/sandbox.ts": "export default {};\n",
        "sandbox/workspace/notes.md": "seed",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sandbox).toEqual({
      sourceKind: "module",
      logicalPath: "sandbox/sandbox.ts",
      sourceId: "sandbox/sandbox.ts",
    });
    expect(result.sandboxWorkspace).not.toBeNull();
    expect(result.sandboxWorkspace?.logicalPath).toBe("sandbox/workspace");
    expect(result.sandboxWorkspace?.rootEntries).toEqual(["notes.md"]);
  });

  it("reports DISCOVER_SANDBOX_FOLDER_EMPTY when sandbox/ has no module or workspace/", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        // Drop a stray file that does not match sandbox.<ext> so the folder is
        // not empty but still has nothing the framework can load.
        "sandbox/README.md": "ignored",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_SANDBOX_FOLDER_EMPTY,
    );
    expect(result.sandbox).toBeNull();
    expect(result.sandboxWorkspace).toBeNull();
  });

  it("reports DISCOVER_MODULE_SLOT_COLLISION when multiple sandbox.<ext> files are present", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "sandbox/sandbox.mjs": "export default {};\n",
        "sandbox/sandbox.ts": "export default {};\n",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_MODULE_SLOT_COLLISION,
    );
    expect(result.sandbox).toBeNull();
    expect(result.sandboxWorkspace).toBeNull();
  });

  it("reports DISCOVER_SANDBOX_WORKSPACE_SKILLS_RESERVED when workspace/ contains a skills/ subtree", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "sandbox/workspace/skills/shadow.md": "shadowed",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_SANDBOX_WORKSPACE_SKILLS_RESERVED,
    );
    expect(result.sandboxWorkspace).toBeNull();
  });

  it("discovers a top-level sandbox.<ext> when no sandbox/ folder exists", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "sandbox.ts": "export default {};\n",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sandbox).toEqual({
      sourceKind: "module",
      logicalPath: "sandbox.ts",
      sourceId: "sandbox.ts",
    });
    expect(result.sandboxWorkspace).toBeNull();
  });

  it("prefers the sandbox/ folder when both it and a top-level sandbox.<ext> exist", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "sandbox.ts": "export default { ignored: true };\n",
        "sandbox/sandbox.ts": "export default {};\n",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sandbox).toEqual({
      sourceKind: "module",
      logicalPath: "sandbox/sandbox.ts",
      sourceId: "sandbox/sandbox.ts",
    });
    expect(result.sandboxWorkspace).toBeNull();
  });

  it("reports DISCOVER_MODULE_SLOT_COLLISION when multiple top-level sandbox.<ext> files are present", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "sandbox.mjs": "export default {};\n",
        "sandbox.ts": "export default {};\n",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_MODULE_SLOT_COLLISION,
    );
    expect(result.sandbox).toBeNull();
    expect(result.sandboxWorkspace).toBeNull();
  });

  it("reports DISCOVER_SANDBOX_DIRECTORY_INVALID when sandbox/ is a file, not a directory", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        sandbox: "not-a-directory",
      },
    });

    const rootEntries = await readSortedDirectoryEntries(project.source, project.agentRoot);
    const result = await discoverSandboxSource({
      rootEntries,
      rootPath: project.agentRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_SANDBOX_DIRECTORY_INVALID,
    );
    expect(result.sandbox).toBeNull();
    expect(result.sandboxWorkspace).toBeNull();
  });
});
