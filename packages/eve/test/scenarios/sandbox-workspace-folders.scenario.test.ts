import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverAgent } from "../../src/discover/discover-agent.js";
import { resolveDiscoveryProject } from "../../src/discover/project.js";
// The just-bash engine keeps this scenario hermetic (no Docker daemon
// requirement); the workspace devDependency provides the install.
import { createSandboxEnvironmentHarness } from "../../src/internal/testing/sandbox-provider-harness.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { SANDBOX_WORKSPACES_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/sandbox-workspaces.js";
import { materializeWorkspaceDirectory } from "../../src/runtime/workspace/seed-files.js";
import { JustBashSandbox } from "../../src/sandbox/providers/just-bash.js";
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
    const trees = await Promise.all(
      discovered.manifest.sandboxWorkspaces.map((workspace) =>
        materializeWorkspaceDirectory(workspace.sourcePath),
      ),
    );

    const appRoot = await createScratchDirectory("eve-sandbox-workspace-folders-");
    const backend = createSandboxEnvironmentHarness(JustBashSandbox.environment());

    await backend.prepare({
      appRoot,
      workspace: trees.flatMap((tree) => tree.workspace),
    });

    const handle = await backend.openSession({
      appRoot,
      sandboxName: "session-default-workspace",
    });

    const notesContent = await handle.sandbox.readTextFile({ path: "/workspace/notes.md" });
    expect(notesContent).not.toBeNull();
    expect(handle.sandbox.resolvePath("/workspace/notes.md")).toBe("/workspace/notes.md");
    expect(handle.sandbox.resolvePath("notes.md")).toBe("/workspace/notes.md");

    // Missing files resolve to `null` instead of throwing.
    const missing = await handle.sandbox.readTextFile({ path: "/workspace/does-not-exist.txt" });
    expect(missing).toBeNull();

    // writeFile round-trip: the session can layer a new file on top of
    // the seeded workspace without running a shell command.
    await handle.sandbox.writeTextFile({ content: "round-trip", path: "/workspace/authored.txt" });
    const roundTrip = await handle.sandbox.readTextFile({ path: "/workspace/authored.txt" });
    expect(roundTrip).toBe("round-trip");

    await handle.connection.stop();
  });

  it("opens an empty prewarmed template when the sandbox has no authored workspace files", async () => {
    const appRoot = await createScratchDirectory("eve-sandbox-no-workspace-");
    const backend = createSandboxEnvironmentHarness(JustBashSandbox.environment());

    await backend.prepare({
      appRoot,
    });

    const handle = await backend.openSession({
      appRoot,
      sandboxName: "session-empty-workspace",
    });

    // An empty prewarmed template snapshots a clean `/workspace` and
    // nothing else; the session opens against it without writing
    // anything visible at the workspace root.
    const result = await handle.sandbox.run({
      command: "ls /workspace 2>/dev/null | wc -l",
    });
    expect(result.exitCode).toBe(0);
    expect(Number(result.stdout.trim())).toBe(0);

    await handle.connection.stop();
  });

  it("materializes a fixture default workspace folder into a deterministic file list", async () => {
    const fixtureApp = await scenarioApp(SANDBOX_WORKSPACES_DESCRIPTOR);
    // Sanity check that the materializer reads the actual fixture from
    // disk and emits the expected workspace-relative paths.
    const resolvedProject = await resolveDiscoveryProject(fixtureApp.appRoot);
    const discovered = await discoverAgent(resolvedProject);
    const [defaultWorkspace] = discovered.manifest.sandboxWorkspaces;
    if (defaultWorkspace === undefined) {
      throw new Error("expected the fixture to expose a default sandbox workspace");
    }

    const { skills, workspace } = await materializeWorkspaceDirectory(defaultWorkspace.sourcePath);

    expect(skills).toEqual([]);
    expect(workspace.map((file) => file.relativePath)).toEqual(["notes.md"]);

    const notesFile = workspace.find((file) => file.relativePath === "notes.md");
    if (notesFile === undefined) {
      throw new Error("expected materialization to include notes.md");
    }

    // Cross-check the bytes by reading the source path directly.
    const onDisk = await readFile(join(defaultWorkspace.sourcePath, "notes.md"), "utf8");
    expect(Buffer.from(notesFile.content).toString("utf8")).toBe(onDisk);
  });
});
