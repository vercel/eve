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

test("built extension contributes its tools and skills and no subagent", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-extension-manifest-"));
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
    await symlink(extensionRoot, join(appRoot, "node_modules", "eve-code"), "dir");
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify({ name: "extension-manifest-consumer", type: "module" }),
    );
    await writeFile(
      join(appRoot, "agent", "extensions", "code.ts"),
      'import code from "eve-code";\nexport default code({});\n',
    );
    await writeFile(join(appRoot, "agent", "instructions.md"), "Work in the repository.\n");
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
    const skillNames = manifest.skills.map((skill) => skill.name);
    for (const name of ["code__investigate", "code__lookup-agent-run", "code__review"]) {
      assert.ok(skillNames.includes(name), name);
    }
    // The deprecated `github` slots are always declared and resolve to nothing without that config.
    assert.ok(manifest.dynamicSkills.some((entry) => entry.slug === "code__pr"));
    assert.ok(manifest.dynamicInstructions.some((entry) => entry.slug === "code__github"));
    const toolNames = manifest.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("code__apply_patch"));
    assert.ok(toolNames.includes("code__grep"));
    assert.ok(manifest.dynamicTools.some((entry) => entry.slug === "code__gh"));
    // Delegation uses eve's own `agent` tool; the extension adds no subagent of its own.
    assert.deepEqual(
      manifest.subagents.filter((item) => item.name.startsWith("code__")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
