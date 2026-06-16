import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { pathExists } from "#setup/path-exists.js";

import { runPackageManagerInstall } from "./run.js";

const createScratchDirectory = useTemporaryDirectories();

// The argv-level unit tests in run-pnpm.test.ts pin which flags we pass; these
// scenarios pin what real pnpm does with them. Both layouts stay offline:
// `workspace:*` and `file:` specifiers never touch the registry.

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeWorkspaceRoot(
  root: string,
  packageJson: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeJson(join(root, "package.json"), {
    name: "scratch-host-root",
    private: true,
    ...packageJson,
  });
}

function collectOutput(): { lines: string[]; onOutput: (line: { text: string }) => void } {
  const lines: string[] = [];
  return { lines, onOutput: ({ text }) => lines.push(text) };
}

describe("runPackageManagerInstall (real pnpm)", () => {
  it("resolves workspace:* dependencies for a claimed workspace member", async () => {
    const root = await createScratchDirectory("eve-pm-claimed-member-");
    await writeWorkspaceRoot(root);
    await writeJson(join(root, "packages", "lib", "package.json"), {
      name: "scratch-lib",
      private: true,
      version: "0.0.1",
    });
    const memberRoot = join(root, "packages", "agent");
    await writeJson(join(memberRoot, "package.json"), {
      dependencies: { "scratch-lib": "workspace:*" },
      name: "scratch-agent",
      private: true,
    });

    const { lines, onOutput } = collectOutput();
    await expect(
      runPackageManagerInstall("pnpm", memberRoot, { onOutput }),
      lines.join("\n"),
    ).resolves.toBe(true);

    await expect(pathExists(join(memberRoot, "node_modules", "scratch-lib"))).resolves.toBe(true);
    // The workspace owns the lockfile; a standalone (`--ignore-workspace`)
    // install would have failed on `workspace:*` or written one here.
    await expect(pathExists(join(root, "pnpm-lock.yaml"))).resolves.toBe(true);
    await expect(pathExists(join(memberRoot, "pnpm-lock.yaml"))).resolves.toBe(false);
  });

  it("installs standalone without executing an unclaiming ancestor workspace", async () => {
    const root = await createScratchDirectory("eve-pm-unclaimed-nested-");
    await writeWorkspaceRoot(root, {
      scripts: {
        preinstall:
          "node -e \"require('node:fs').writeFileSync('ancestor-preinstall-ran', 'yes')\"",
      },
    });
    await writeJson(join(root, "packages", "claimed", "package.json"), {
      name: "scratch-claimed",
      private: true,
    });
    await writeJson(join(root, "vendored", "local-dep", "package.json"), {
      name: "scratch-local-dep",
      private: true,
      version: "0.0.1",
    });
    const nestedRoot = join(root, "nested", "agent");
    await writeJson(join(nestedRoot, "package.json"), {
      dependencies: { "scratch-local-dep": "file:../../vendored/local-dep" },
      name: "scratch-nested-agent",
      private: true,
    });
    // Existing projects commonly already have node_modules. Its presence must
    // not suppress unclaimed-workspace detection.
    await mkdir(join(nestedRoot, "node_modules"), { recursive: true });

    const { lines, onOutput } = collectOutput();
    await expect(
      runPackageManagerInstall("pnpm", nestedRoot, { onOutput }),
      lines.join("\n"),
    ).resolves.toBe(true);

    await expect(pathExists(join(nestedRoot, "node_modules", "scratch-local-dep"))).resolves.toBe(
      true,
    );
    await expect(pathExists(join(nestedRoot, "pnpm-lock.yaml"))).resolves.toBe(true);
    await expect(pathExists(join(root, "ancestor-preinstall-ran"))).resolves.toBe(false);
  });
});
