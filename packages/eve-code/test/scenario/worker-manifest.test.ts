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

test("built worker keeps explicit read tools without shell or write capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-worker-manifest-"));
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
      JSON.stringify({ name: "worker-manifest-consumer", type: "module" }),
    );
    await writeFile(
      join(appRoot, "agent", "extensions", "code.ts"),
      'import code from "eve-code";\nexport default code({});\n',
    );
    await writeFile(join(appRoot, "agent", "instructions.md"), "Delegate repository research.\n");
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
    const worker = manifest.subagents.find((item) => item.name === "code__worker");
    assert.ok(worker);
    assert.equal(worker.configResolver, undefined);
    assert.ok("config" in worker.agent);
    const toolNames = worker.agent.tools.map((tool) => tool.name).sort();
    assert.ok(!toolNames.includes("bash"), "a read-only worker must not receive default bash");
    assert.ok(!toolNames.includes("write_file"));
    assert.ok(!toolNames.includes("apply_patch"));
    assert.equal(worker.agent.config.defaultTools, false);
    assert.deepEqual(toolNames, ["glob", "grep", "read_file"]);
    for (const tool of worker.agent.tools) assert.equal(tool.hasExecute, true);
    assert.deepEqual(worker.agent.connections, []);
    assert.deepEqual(
      worker.agent.dynamicTools.map((tool) => tool.slug),
      ["connection_search"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
