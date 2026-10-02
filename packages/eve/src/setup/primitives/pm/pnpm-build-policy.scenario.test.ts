import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { pathExists } from "#setup/path-exists.js";
import { ensurePnpmOptionalDependencyDefaults } from "./pnpm-build-policy.js";

const createScratchDirectory = useTemporaryDirectories();
const packages = ["@mongodb-js/zstd", "node-liblzma"];

describe("pnpm optional dependency policy ownership", () => {
  it("creates standalone defaults and leaves them unchanged on repeat preparation", async () => {
    const root = await createScratchDirectory("eve-optional-policy-");
    await ensurePnpmOptionalDependencyDefaults(root, packages);
    const file = join(root, "pnpm-workspace.yaml");
    const policy = await readFile(file, "utf8");
    expect(policy).toContain('  - "node-liblzma"');
    await ensurePnpmOptionalDependencyDefaults(root, packages);
    expect(await readFile(file, "utf8")).toBe(policy);
  });

  it("updates the owning workspace and preserves existing build decisions", async () => {
    const root = await createScratchDirectory("eve-optional-workspace-policy-");
    const member = join(root, "apps", "agent");
    await mkdir(member, { recursive: true });
    const file = join(root, "pnpm-workspace.yaml");
    await writeFile(
      file,
      'packages:\n  - apps/*\nallowBuilds:\n  "@mongodb-js/zstd": false\n  esbuild: true\n',
    );
    await ensurePnpmOptionalDependencyDefaults(member, packages);
    const policy = await readFile(file, "utf8");
    expect(policy).toContain('  "@mongodb-js/zstd": false');
    expect(policy).toContain('  - "node-liblzma"');
    expect(policy).toContain("  esbuild: true");
    expect(await pathExists(join(member, "pnpm-workspace.yaml"))).toBe(false);
  });
});
