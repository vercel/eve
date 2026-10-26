import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

import type { CompilerDiagnostic } from "../../../eve/dist/src/compiler/diagnostics.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "../../../eve/dist/src/compiler/manifest.js";
import { compileAgentManifest } from "../../../eve/dist/src/compiler/normalize-manifest.js";
import { discoverAgent } from "../../../eve/dist/src/discover/discover-agent.js";
import { bundleAuthoredModuleMapForGeneration } from "../../../eve/dist/src/internal/authored-module-loader.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "../../../eve/dist/src/internal/nitro/host/build-extension.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
let root: string;
let extensionRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "eve-git-manifest-"));
  extensionRoot = join(root, "extension-package");
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
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function compileConsumer(name: string, gitConfig: string) {
  const appRoot = join(root, name);
  await mkdir(join(appRoot, "agent", "extensions"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"));
  await symlink(
    join(packageRoot, "node_modules", "eve"),
    join(appRoot, "node_modules", "eve"),
    "dir",
  );
  await symlink(extensionRoot, join(appRoot, "node_modules", "eve-git"), "dir");
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name, type: "module" }));
  await writeFile(
    join(appRoot, "agent", "extensions", "git.ts"),
    `import git from "eve-git";\nexport default git(${gitConfig});\n`,
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
  return { appRoot, manifest };
}

test("built extension mounts as git with only session-resolved GitHub contributions", async () => {
  const { manifest } = await compileConsumer("git-manifest-consumer", "{}");
  assert.ok(manifest.dynamicSkills.some((entry) => entry.slug === "git__pr"));
  assert.ok(manifest.dynamicInstructions.some((entry) => entry.slug === "git__github"));
  assert.ok(manifest.dynamicTools.some((entry) => entry.slug === "git__gh"));
  assert.ok(!manifest.tools.some((tool) => tool.name.startsWith("git__")));
});

test("git__gh resolves an executable tool when GitHub is configured", async () => {
  const { appRoot, manifest } = await compileConsumer(
    "git-gh-consumer",
    '{ github: { connector: "github/acme-bot", org: "acme", async broker() {} } }',
  );
  const resolver = manifest.dynamicTools.find((entry) => entry.slug === "git__gh");
  assert.ok(resolver);

  // Evaluate the packaged resolver through the app bundle, not its source export.
  const moduleMapPath = join(appRoot, ".eve", "compile", "module-map.mjs");
  const { code } = await bundleAuthoredModuleMapForGeneration({ appRoot, manifest, moduleMapPath });
  await mkdir(join(appRoot, ".eve", "compile"), { recursive: true });
  await writeFile(moduleMapPath, code);
  const { moduleMap } = await import(pathToFileURL(moduleMapPath).href);
  const definition =
    moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID].modules[resolver.sourceId].default;
  const tool = await definition.evaluate();
  assert.ok(tool, "gh resolved to null with github configured");
  const input = tool.inputSchema.parse({
    command: "gh repo view acme/project",
    description: "Read the project metadata.",
    permissions: [{ provider: "github", repositories: ["acme/project"], access: "write" }],
  });
  assert.equal(tool.approval({ toolInput: input }), "not-applicable");
  assert.equal(typeof tool.execute, "function");
});
