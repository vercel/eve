import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionCodeHash } from "./session-code-hash.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const monorepoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workspaceYamlPath = join(monorepoRoot, "pnpm-workspace.yaml");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

async function resolveCatalogVersion(packageName) {
  const contents = await readFile(workspaceYamlPath, "utf8");
  const lines = contents.split(/\r?\n/);
  let inCatalog = false;
  for (const line of lines) {
    if (/^catalog:\s*$/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog) {
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s+(?:"([^"]+)"|([\w@/.-]+)):\s*"([^"]+)"/);
      if (!match) continue;
      const name = match[1] ?? match[2];
      if (name === packageName) return match[3];
    }
  }
  throw new Error(`Could not find "${packageName}" in catalog at ${workspaceYamlPath}`);
}

const nodeEngine = packageJson.engines?.node;
if (typeof nodeEngine !== "string") {
  throw new Error("eve package.json is missing a string engines.node");
}

const evePackageDependencyVersion = process.env.EVE_PACKAGE_DEPENDENCY_URL ?? packageJson.version;

const replacements = {
  __EVE_PACKAGE_VERSION__: packageJson.version,
  __EVE_SESSION_CODE_HASH__: await sessionCodeHash(packageRoot),
  __EVE_PACKAGE_DEPENDENCY_VERSION__: evePackageDependencyVersion,
  __NODE_ENGINE__: nodeEngine,
  __AI_SDK_VERSION__: await resolveCatalogVersion("ai"),
  __BETTER_AUTH_VERSION__: await resolveCatalogVersion("better-auth"),
  __NEXT_VERSION__: await resolveCatalogVersion("next"),
  __REACT_VERSION__: await resolveCatalogVersion("react"),
  __REACT_DOM_VERSION__: await resolveCatalogVersion("react-dom"),
  __STREAMDOWN_VERSION__: await resolveCatalogVersion("streamdown"),
  __ZOD_VERSION__: await resolveCatalogVersion("zod"),
  __TYPESCRIPT_VERSION__: await resolveCatalogVersion("typescript"),
  __TYPES_REACT_VERSION__: await resolveCatalogVersion("@types/react"),
  __TYPES_REACT_DOM_VERSION__: await resolveCatalogVersion("@types/react-dom"),
};

const tokenPattern = new RegExp(
  `(${Object.keys(replacements)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})`,
  "g",
);

async function* walkJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsFiles(path);
    } else if (entry.isFile() && path.endsWith(".js")) {
      yield path;
    }
  }
}

for await (const path of walkJsFiles(join(packageRoot, "dist"))) {
  const source = await readFile(path, "utf8");
  if (!tokenPattern.test(source)) continue;
  tokenPattern.lastIndex = 0;
  const next = source.replace(tokenPattern, (match) => replacements[match]);
  if (next !== source) {
    await writeFile(path, next, "utf8");
  }
}
