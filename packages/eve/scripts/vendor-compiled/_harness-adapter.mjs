import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { loadDeclaration } from "./_shared.mjs";

const adapterDeclaration = await loadDeclaration("ai-sdk-harness-adapter.d.ts");

export function createHarnessAdapterConfig({ packageName, bridgeAssets = false }) {
  return {
    packageName,
    compiledPath: packageName,
    chunkGroup: "harness",
    declaration: adapterDeclaration,
    plugins: [createHarnessImportRedirectPlugin()],
    copyDeclarations: bridgeAssets ? copyBridgeAssets : undefined,
    external(source) {
      return source === "ai" || source.startsWith("ai/");
    },
  };
}

function createHarnessImportRedirectPlugin() {
  const redirects = new Map([
    ["@ai-sdk/harness", "#compiled/@ai-sdk/harness/index.js"],
    ["@ai-sdk/harness/agent", "#compiled/@ai-sdk/harness/agent/index.js"],
    ["@ai-sdk/harness/utils", "#compiled/@ai-sdk/harness/utils/index.js"],
  ]);

  return {
    name: "eve-harness-import-redirect",
    resolveId(source) {
      const id = redirects.get(source);
      return id === undefined ? undefined : { id, external: true };
    },
  };
}

async function copyBridgeAssets({ destinationRoot, packageInfo }) {
  const sourceRoot = join(packageInfo.packageRoot, "dist", "bridge");
  const destination = join(destinationRoot, "bridge");
  await mkdir(destination, { recursive: true });
  await Promise.all(
    (await readdir(sourceRoot))
      .filter((file) => !file.endsWith(".map"))
      .map((file) => copyFile(join(sourceRoot, file), join(destination, file))),
  );
}
