import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build-stamp tokens authored in scaffold sources, mapped to the source of
 * truth each one is stamped from. `pnpm build` rewrites the tokens in `dist`
 * as its final step (`scripts/stamp-version-tokens.mjs`); dev-tree executions
 * — tsgo watch emits and tests running from `src` — never run that step, so
 * {@link resolveVersionToken} resolves the same sources at the point of need.
 */
type TokenSource =
  | { kind: "eve-version" }
  | { kind: "eve-node-engine" }
  | { kind: "catalog"; packageName: string };

function versionToken(name: string): string {
  return `__${name}_VERSION__`;
}

// Built at runtime, never written as a literal. The build stamper rewrites the
// token only at its use site (DEFAULT_EVE_PACKAGE_CONTRACT); a literal here
// would let it corrupt this lookup key too. Same reason versionToken()
// constructs its tokens. Kept in sync with the key in stamp-version-tokens.mjs.
function bareToken(name: string): string {
  return `__${name}__`;
}

const NODE_ENGINE_TOKEN = bareToken("NODE_ENGINE");

const TOKEN_SOURCES: Readonly<Record<string, TokenSource>> = {
  [versionToken("EVE_PACKAGE")]: { kind: "eve-version" },
  [NODE_ENGINE_TOKEN]: { kind: "eve-node-engine" },
  [versionToken("AI_SDK")]: { kind: "catalog", packageName: "ai" },
  [versionToken("VERCEL_CONNECT")]: { kind: "catalog", packageName: "@vercel/connect" },
  [versionToken("NEXT")]: { kind: "catalog", packageName: "next" },
  [versionToken("REACT")]: { kind: "catalog", packageName: "react" },
  [versionToken("REACT_DOM")]: { kind: "catalog", packageName: "react-dom" },
  [versionToken("STREAMDOWN")]: { kind: "catalog", packageName: "streamdown" },
  [versionToken("ZOD")]: { kind: "catalog", packageName: "zod" },
  [versionToken("TSGO")]: { kind: "catalog", packageName: "@typescript/native-preview" },
  [versionToken("TYPES_REACT")]: { kind: "catalog", packageName: "@types/react" },
  [versionToken("TYPES_REACT_DOM")]: { kind: "catalog", packageName: "@types/react-dom" },
};

// The published name; rule 28 keeps the scaffold layer free of `#internal/*`
// imports, so the shared package-name constant cannot be reused here.
const EVE_PACKAGE_NAME = "eve";

// Published tarballs ship only bin/ and dist/ (package.json `files`), so the
// stamp script's presence next to the package marks a dev checkout. Without
// this gate an unstamped *publish* running inside a consumer's pnpm workspace
// would silently pin the consumer's catalog versions instead of failing loudly.
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

// Line-oriented mirror of resolveCatalogVersion in
// scripts/stamp-version-tokens.mjs, which cannot be imported: it is a build
// script that must run before dist exists.
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
    // Any filesystem or parse failure falls through to the unstamped throw;
    // the fallback must never turn a loud failure into a corrupt scaffold.
    return undefined;
  }
}

/**
 * Returns a scaffold version value, resolving a build-stamp token at the point
 * of need when the running code is unstamped. The published package is stamped
 * by the build (`scripts/stamp-version-tokens.mjs`), so the fallback only ever
 * fires in a dev tree — tsgo watch emits and tests running from `src` — where
 * the live workspace catalog *is* the truth the stamp would have captured.
 * Outside a dev tree an unstamped token still throws, because writing the
 * literal token into a scaffolded package.json would break the generated
 * project.
 */
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
