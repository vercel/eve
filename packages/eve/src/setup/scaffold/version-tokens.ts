import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type TokenSource =
  | { kind: "eve-version" }
  | { kind: "eve-node-engine" }
  | { kind: "catalog"; packageName: string };

function versionToken(name: string): string {
  return `__${name}_VERSION__`;
}

function bareToken(name: string): string {
  return `__${name}__`;
}

const NODE_ENGINE_TOKEN = bareToken("NODE_ENGINE");

export const DEFAULT_CONNECT_PACKAGE_VERSION = "2.7.0";

const TOKEN_SOURCES: Readonly<Record<string, TokenSource>> = {
  [versionToken("EVE_PACKAGE")]: { kind: "eve-version" },
  [versionToken("EVE_PACKAGE_DEPENDENCY")]: { kind: "eve-version" },
  [NODE_ENGINE_TOKEN]: { kind: "eve-node-engine" },
  [versionToken("AI_SDK")]: { kind: "catalog", packageName: "ai" },
  [versionToken("NEXT")]: { kind: "catalog", packageName: "next" },
  [versionToken("REACT")]: { kind: "catalog", packageName: "react" },
  [versionToken("REACT_DOM")]: { kind: "catalog", packageName: "react-dom" },
  [versionToken("STREAMDOWN")]: { kind: "catalog", packageName: "streamdown" },
  [versionToken("ZOD")]: { kind: "catalog", packageName: "zod" },
  [versionToken("TYPESCRIPT")]: { kind: "catalog", packageName: "typescript" },
  [versionToken("TYPES_REACT")]: { kind: "catalog", packageName: "@types/react" },
  [versionToken("TYPES_REACT_DOM")]: { kind: "catalog", packageName: "@types/react-dom" },
};

const EVE_PACKAGE_NAME = "eve";

const DEV_TREE_MARKER = "scripts/stamp-version-tokens.mjs";

const resolvedTokens = new Map<string, string>();

function findEvePackageRoot(): string | undefined {
  let directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  while (true) {
    const packageJsonPath = join(directory, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
      if (packageJson.name === EVE_PACKAGE_NAME) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function findWorkspaceManifest(packageRoot: string): string | undefined {
  let directory = packageRoot;
  while (true) {
    const manifestPath = join(directory, "pnpm-workspace.yaml");
    if (existsSync(manifestPath)) return manifestPath;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function readCatalogVersion(manifestPath: string, packageName: string): string | undefined {
  const lines = readFileSync(manifestPath, "utf8").split(/\r?\n/);
  let inCatalog = false;
  for (const line of lines) {
    if (/^catalog:\s*$/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (!inCatalog) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+(?:"([^"]+)"|([\w@/.-]+)):\s*"([^"]+)"/);
    if (!match) continue;
    if ((match[1] ?? match[2]) === packageName) return match[3];
  }
  return undefined;
}

function resolveTokenFromDevTree(token: string): string | undefined {
  const source = TOKEN_SOURCES[token];
  if (source === undefined) return undefined;
  try {
    const packageRoot = findEvePackageRoot();
    if (packageRoot === undefined || !existsSync(join(packageRoot, DEV_TREE_MARKER))) {
      return undefined;
    }
    if (source.kind === "eve-version") {
      const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
        version?: unknown;
      };
      return typeof packageJson.version === "string" ? packageJson.version : undefined;
    }
    if (source.kind === "eve-node-engine") {
      const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
        engines?: { node?: unknown };
      };
      const node = packageJson.engines?.node;
      return typeof node === "string" ? node : undefined;
    }
    const manifestPath = findWorkspaceManifest(packageRoot);
    if (manifestPath === undefined) return undefined;
    return readCatalogVersion(manifestPath, source.packageName);
  } catch {
    return undefined;
  }
}

export function resolveVersionToken(field: string, value: string): string {
  if (!value.startsWith("__")) return value;
  const cached = resolvedTokens.get(value);
  if (cached !== undefined) return cached;
  const resolved = resolveTokenFromDevTree(value);
  if (resolved === undefined) {
    throw new Error(
      `Scaffold received unstamped version token (${field}=${value}). ` +
        "Build eve before using its dist entrypoint.",
    );
  }
  resolvedTokens.set(value, resolved);
  return resolved;
}
