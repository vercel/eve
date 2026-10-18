import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { ROOT_COMPILED_AGENT_NODE_ID } from "../../../eve/dist/src/compiler/manifest.js";
import { compileAgentManifest } from "../../../eve/dist/src/compiler/normalize-manifest.js";
import { validateDurableDynamicToolCallbacks } from "../../../eve/dist/src/context/dynamic-tool-lifecycle.js";
import { discoverAgent } from "../../../eve/dist/src/discover/discover-agent.js";
import { bundleAuthoredModuleMapForGeneration } from "../../../eve/dist/src/internal/authored-module-loader.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "../../../eve/dist/src/internal/nitro/host/build-extension.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

// The app bundle stamps every defineTool() callback with the values it captures so eve can
// replay the tool in a later process. eve drops a dynamic tool whose captures are not JSON.
test("gh resolves with replayable callbacks when github is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-git-gh-"));
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
      JSON.stringify({ name: "git-gh-consumer", type: "module" }),
    );
    await writeFile(
      join(appRoot, "agent", "extensions", "git.ts"),
      'import git from "eve-git";\nexport default git({ github: { connector: "github/acme-bot", org: "acme", async broker() {} } });\n',
    );
    await writeFile(join(appRoot, "agent", "instructions.md"), "Publish changes.\n");
    const discovered = await discoverAgent({ appRoot, agentRoot: join(appRoot, "agent") });
    const manifest = await compileAgentManifest(discovered.manifest);
    const resolver = manifest.dynamicTools.find((entry) => entry.slug === "git__gh");
    assert.ok(resolver);

    const moduleMapPath = join(appRoot, ".eve", "compile", "module-map.mjs");
    const { code } = await bundleAuthoredModuleMapForGeneration({
      appRoot,
      manifest,
      moduleMapPath,
    });
    await mkdir(join(appRoot, ".eve", "compile"), { recursive: true });
    await writeFile(moduleMapPath, code);
    const { moduleMap } = await import(pathToFileURL(moduleMapPath).href);
    const definition =
      moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID].modules[resolver.sourceId].default;
    const tool = await definition.events["session.started"]();
    assert.ok(tool, "gh resolved to null with github configured");

    // Bug #4986: execute captures the config getter, so eve rejects git__gh. The fix
    // replaces this assertion with one that validation succeeds.
    assert.throws(
      () =>
        validateDurableDynamicToolCallbacks("git__gh", tool, {
          entryKey: "gh",
          name: "git__gh",
          resolverSlug: resolver.slug,
          scope: "session",
          sessionId: "session",
        }),
      /Dynamic tool "git__gh" callback "execute" has a non-serializable capture/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
