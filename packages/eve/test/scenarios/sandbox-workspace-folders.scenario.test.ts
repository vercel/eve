import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverAgent } from "../../src/discover/discover-agent.js";
import { resolveDiscoveryProject } from "../../src/discover/project.js";
// The just-bash engine keeps this scenario hermetic (no Docker daemon
// requirement); the workspace devDependency provides the install.
import { createJustBashSandboxBackend } from "../../src/execution/sandbox/bindings/just-bash.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { SANDBOX_WORKSPACES_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/sandbox-workspaces.js";
import { materializeWorkspaceDirectory } from "../../src/runtime/workspace/seed-files.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const scenarioApp = useScenarioApp();
const createScratchDirectory = useTemporaryDirectories();

describe("sandbox workspace folder convention", () => {
  it("flows authored workspace files from disk through discovery into a live sandbox", async () => {
    const fixtureApp = await scenarioApp(SANDBOX_WORKSPACES_DESCRIPTOR);
    // 1. Discovery — folder-form sandbox + workspace-only default override.
    const resolvedProject = await resolveDiscoveryProject(fixtureApp.appRoot);
    const discovered = await discoverAgent(resolvedProject);
    expect(discovered.diagnostics).toEqual([]);

    // 2. Materialize the authored workspace folder into prewarm seed
    // files. Production routes these through
    // `materializeWorkspaceResources` → `prewarmSandboxes`; this test
    // exercises the disk → sandbox round trip directly with the
    // discovery output so it can stay focused on the local backend.
    const files = (
      await Promise.all(
        discovered.manifest.sandboxWorkspaces.map((workspace) =>
          materializeWorkspaceDirectory(workspace.sourcePath),
        ),
      )
    ).flat();

    const appRoot = await createScratchDirectory("eve-sandbox-workspace-folders-");
    const backend = createJustBashSandboxBackend();

    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: files.map((file) => ({ content: file.content, path: file.path })),
      templateKey: "template-default-workspace",
    });

    const handle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-default-workspace",
      templateKey: "template-default-workspace",
    });

    const notesContent = await handle.session.readTextFile({ path: "/workspace/notes.md" });
    expect(notesContent).not.toBeNull();
    expect(handle.session.resolvePath("/workspace/notes.md")).toBe("/workspace/notes.md");
    expect(handle.session.resolvePath("notes.md")).toBe("/workspace/notes.md");

    // Missing files resolve to `null` instead of throwing.
    const missing = await handle.session.readTextFile({ path: "/workspace/does-not-exist.txt" });
    expect(missing).toBeNull();

    // writeFile round-trip: the session can layer a new file on top of
    // the seeded workspace without running a shell command.
    await handle.session.writeTextFile({ content: "round-trip", path: "/workspace/authored.txt" });
    const roundTrip = await handle.session.readTextFile({ path: "/workspace/authored.txt" });
    expect(roundTrip).toBe("round-trip");

    await handle.shutdown();
  });

  it("opens an empty prewarmed template when the sandbox has no authored workspace files", async () => {
    const appRoot = await createScratchDirectory("eve-sandbox-no-workspace-");
    const backend = createJustBashSandboxBackend();

    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [],
      templateKey: "template-empty-workspace",
    });

    const handle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-empty-workspace",
      templateKey: "template-empty-workspace",
    });

    // An empty prewarmed template snapshots a clean `/workspace` and
    // nothing else; the session opens against it without writing
    // anything visible at the workspace root.
    const result = await handle.session.run({
      command: "ls /workspace 2>/dev/null | wc -l",
    });
    expect(result.exitCode).toBe(0);
    expect(Number(result.stdout.trim())).toBe(0);

    await handle.shutdown();
  });

  it("materializes a fixture default workspace folder into a deterministic file list", async () => {
    const fixtureApp = await scenarioApp(SANDBOX_WORKSPACES_DESCRIPTOR);
    // Sanity check that the materializer reads the actual fixture from
    // disk and emits the expected logical paths under /workspace.
    const resolvedProject = await resolveDiscoveryProject(fixtureApp.appRoot);
    const discovered = await discoverAgent(resolvedProject);
    const [defaultWorkspace] = discovered.manifest.sandboxWorkspaces;
    if (defaultWorkspace === undefined) {
      throw new Error("expected the fixture to expose a default sandbox workspace");
    }

    const files = await materializeWorkspaceDirectory(defaultWorkspace.sourcePath);

    expect(files.map((file) => file.path).sort()).toEqual(["/workspace/notes.md"]);

    const notesFile = files.find((file) => file.path === "/workspace/notes.md");
    if (notesFile === undefined) {
      throw new Error("expected materialization to include /workspace/notes.md");
    }

    // Cross-check the bytes by reading the source path directly.
    const onDisk = await readFile(join(defaultWorkspace.sourcePath, "notes.md"), "utf8");
    expect(notesFile.content.toString("utf8")).toBe(onDisk);
  });
});
