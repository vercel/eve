import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { validateDurableDynamicToolCallbacks } from "../../../eve/dist/src/context/dynamic-tool-lifecycle.js";
import { transformDynamicToolExecute } from "../../../eve/dist/src/internal/workflow-bundle/dynamic-tool-transform.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

// Session start rejects a dynamic tool whose callbacks capture anything but JSON
// and drops it. Running every extension module through the build's transform
// gives the resolved tool the same callback stamps a deployed agent validates.
test("deprecated code__gh resolves at session start with only JSON captures", async () => {
  const root = await mkdtemp(join(packageRoot, ".gh-dynamic-tool-"));
  try {
    const extensionRoot = join(root, "extension");
    await cp(join(packageRoot, "extension"), extensionRoot, { recursive: true });
    for (const entry of await readdir(extensionRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const path = join(entry.parentPath, entry.name);
      const result = await transformDynamicToolExecute(path, await readFile(path, "utf8"));
      if (result !== null) await writeFile(path, result.code);
    }

    const { default: extension } = await import(
      pathToFileURL(join(extensionRoot, "extension.ts")).href
    );
    const { default: gh } = await import(pathToFileURL(join(extensionRoot, "tools/gh.ts")).href);
    extension({ github: { connector: "github/acme-bot", org: "acme", broker: async () => {} } });
    const tool = await gh.events["session.started"]();
    assert.ok(tool);

    const callbacks = validateDurableDynamicToolCallbacks("code__gh", tool, {
      sessionId: "gh-dynamic-tool-test",
      scope: "session",
      resolverSlug: "code__gh",
      entryKey: "code__gh",
      name: "code__gh",
    });
    assert.deepEqual(callbacks.execute.closure, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
