import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

import { collectDependencyFacts, collectPackageManagerFacts } from "./collectors.js";
import { runDoctor } from "./doctor.js";

const createScratchDirectory = useTemporaryDirectories();

async function createWorkspace(root: string): Promise<void> {
  await mkdir(join(root, "agents", "research", "agent"), { recursive: true });
  await mkdir(join(root, "agents", "support", "agent"), { recursive: true });
  await mkdir(join(root, "node_modules", "eve"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { eve: "workspace:*" }, packageManager: "pnpm@11" }),
  );
  await writeFile(join(root, "node_modules", "eve", "package.json"), "{}\n");
  await writeFile(join(root, "agents", "research", "agent", "instructions.md"), "Research.\n");
  await writeFile(join(root, "agents", "support", "agent", "instructions.md"), "Support.\n");
}

describe("runDoctor", () => {
  it("reports every workspace member from the workspace root", async () => {
    const root = await createScratchDirectory("eve-doctor-workspace-");
    await createWorkspace(root);

    const result = await runDoctor(root, { offline: true });

    expect(result.scope).toBe("workspace");
    expect(result.workspaceRoot).toBe(root);
    expect(result.agents.map((agent) => agent.name)).toEqual(["research", "support"]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "vercel.authentication", status: "unknown" }),
      ]),
    );
  });

  it("fails discovery for an invalid project package", async () => {
    const root = await createScratchDirectory("eve-doctor-invalid-package-");
    await mkdir(join(root, "agent"));
    await writeFile(join(root, "package.json"), "{ invalid json");

    const result = await runDoctor(root, { offline: true });

    expect(result.summary.fail).toBeGreaterThan(0);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project.discovery", status: "fail" }),
      ]),
    );
  });

  it("recognizes Yarn Plug'n'Play without a node_modules directory", async () => {
    const root = await createScratchDirectory("eve-doctor-pnp-");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { eve: "workspace:*" }, packageManager: "yarn@4" }),
    );
    await writeFile(join(root, ".pnp.cjs"), "module.exports = {};\n");

    await expect(
      collectDependencyFacts(root, await collectPackageManagerFacts(root)),
    ).resolves.toEqual({
      kind: "installed",
    });
  });

  it("detects a lockfile for a manager other than the selected manager", async () => {
    const root = await createScratchDirectory("eve-doctor-lockfile-");
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11" }));
    await writeFile(join(root, "package-lock.json"), "{}\n");

    await expect(collectPackageManagerFacts(root)).resolves.toMatchObject({
      manager: "pnpm",
      conflict: true,
    });
  });

  it("limits a workspace-member invocation to that member", async () => {
    const root = await createScratchDirectory("eve-doctor-member-");
    await createWorkspace(root);

    const result = await runDoctor(join(root, "agents", "support"), { offline: true });

    expect(result.scope).toBe("workspace");
    expect(result.agents.map((agent) => agent.name)).toEqual(["support"]);
  });
});
