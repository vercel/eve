import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { CompilerDiagnostic } from "../../../eve/dist/src/compiler/diagnostics.js";
import { compileAgentManifest } from "../../../eve/dist/src/compiler/normalize-manifest.js";
import { discoverAgent } from "../../../eve/dist/src/discover/discover-agent.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "../../../eve/dist/src/internal/nitro/host/build-extension.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

test("built extension mounts as git with only session-resolved GitHub contributions", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-git-manifest-"));
  try {
    const extensionRoot = join(root, "extension-package");
    await mkdir(extensionRoot);
    for (const path of ["package.json", "tsconfig.json", "extension"]) {
      await cp(join(packageRoot, path), join(extensionRoot, path), { recursive: true });
    }
    await symlink(join(packageRoot, "node_modules"), join(extensionRoot, "node_modules"), "dir");
    const config = await tryReadExtensionBuildConfig(extensionRoot);
    assert.ok(config);
    await buildExtensionPackage(extensionRoot, config);
    // Consume only the distribution, so source discovery cannot hide a packaging regression.
    await rm(join(extensionRoot, "extension"), { recursive: true });

    const appRoot = join(root, "consumer");
    await mkdir(join(appRoot, "agent", "extensions"), { recursive: true });
    await mkdir(join(appRoot, "node_modules"));
    await symlink(
      join(packageRoot, "node_modules", "eve"),
      join(appRoot, "node_modules", "eve"),
      "dir",
    );
    await symlink(extensionRoot, join(appRoot, "node_modules", "eve-git"), "dir");
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify({ name: "git-manifest-consumer", type: "module" }),
    );
    await writeFile(
      join(appRoot, "agent", "extensions", "git.ts"),
      'import git from "eve-git";\nexport default git({});\n',
    );
    await writeFile(join(appRoot, "agent", "instructions.md"), "Publish changes.\n");
    const discovered = await discoverAgent({ appRoot, agentRoot: join(appRoot, "agent") });
    assert.deepEqual(
      discovered.diagnostics.filter((item) => item.severity === "error"),
      [],
    );
    const diagnostics: CompilerDiagnostic[] = [];
    const manifest = await compileAgentManifest(discovered.manifest, { diagnostics });
    assert.deepEqual(
      diagnostics.filter((item) => item.severity === "error"),
      [],
    );
    assert.ok(manifest.dynamicSkills.some((entry) => entry.slug === "git__pr"));
    assert.ok(manifest.dynamicInstructions.some((entry) => entry.slug === "git__github"));
    assert.ok(manifest.dynamicTools.some((entry) => entry.slug === "git__gh"));
    assert.ok(!manifest.tools.some((tool) => tool.name.startsWith("git__")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
