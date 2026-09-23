import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

// eve's Zod is private: see "Zod boundary" in AGENTS.md. These checks run on
// the built package, the same files an app installs.

const execFileAsync = promisify(execFile);
const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST_SRC = join(EVE_PACKAGE_ROOT, "dist", "src");

// Every Zod 4 copy registers its core classes by name.
const ZOD_CORE_MARKER = /[`"']\$ZodType[`"']/;
const ZOD_DECLARATION_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*)["'](?:#compiled\/zod(?:\/[^"']*)?|zod(?:\/[^"']*)?)["']/;

// Public declarations that still spell their types with Zod, which resolves
// against whatever Zod the app installed. This list may only shrink: declare
// public types in TypeScript and type exported schema values as Standard
// Schemas instead of exporting `z.infer` types.
const PUBLIC_DECLARATIONS_WITH_ZOD_TYPES = [
  "client/agent-info-schema.d.ts",
  "client/health-schema.d.ts",
  "compiler/manifest.d.ts",
  "compiler/remote-agent-node.d.ts",
  "discover/diagnostics.d.ts",
  "internal/vercel/project-link.d.ts",
  "protocol/cancel-turn.d.ts",
  "protocol/clear-session.d.ts",
  "protocol/compact-session.d.ts",
  "protocol/reset-session.d.ts",
  "services/dev-client/request-headers.d.ts",
  "setup/slack-connect.d.ts",
  "setup/vercel-project-api.d.ts",
  "shared/action-types.d.ts",
  "shared/agent-turn-outcome.d.ts",
  "shared/input.d.ts",
  "shared/token-usage.d.ts",
];

type PackageExportTarget = string | { readonly import?: string; readonly types?: string };

async function readPackageExports(): Promise<Record<string, PackageExportTarget>> {
  const packageJson = JSON.parse(await readFile(join(EVE_PACKAGE_ROOT, "package.json"), "utf8"));
  return packageJson.exports as Record<string, PackageExportTarget>;
}

async function listFiles(directory: string, extension: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath, entry.name));
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function resolveDeclaration(fromFile: string, specifier: string): string | undefined {
  let target: string;
  if (specifier.startsWith(".")) target = resolve(dirname(fromFile), specifier);
  else if (specifier.startsWith("#")) target = join(DIST_SRC, specifier.slice(1));
  else return undefined;
  const declaration = target.replace(/\.(?:d\.ts|ts|js)$/, "") + ".d.ts";
  return existsSync(declaration) ? declaration : undefined;
}

describe("Zod boundary", () => {
  it("exports no Zod schema from any public entrypoint", async () => {
    const entrypoints = Object.values(await readPackageExports())
      .map((target) => (typeof target === "string" ? target : target.import))
      .filter((target): target is string => target?.endsWith(".js") === true)
      .map((target) => join(EVE_PACKAGE_ROOT, target));

    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        const isZod = (value) =>
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          ("_zod" in value || value["~standard"]?.vendor === "zod");
        const leaks = [];
        for (const entrypoint of ${JSON.stringify(entrypoints)}) {
          for (const [name, value] of Object.entries(await import(entrypoint))) {
            if (isZod(value)) leaks.push(entrypoint + " exports " + name);
            else if (value !== null && typeof value === "object") {
              for (const [key, member] of Object.entries(value)) {
                if (isZod(member)) leaks.push(entrypoint + " exports " + name + "." + key);
              }
            }
          }
        }
        process.stdout.write(JSON.stringify(leaks));
      `,
    ]);

    expect(entrypoints.length).toBeGreaterThan(50);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("ships exactly one Zod implementation", async () => {
    const zodCores: string[] = [];
    for (const file of await listFiles(DIST_SRC, ".js")) {
      if (ZOD_CORE_MARKER.test(await readFile(file, "utf8"))) {
        zodCores.push(relative(DIST_SRC, file).split(sep).join("/"));
      }
    }

    // Vendored packages and eve's own sources import `#compiled/zod/*`
    // instead of bundling Zod or copying its sources into dist.
    expect(zodCores).toHaveLength(1);
    expect(zodCores[0]).toMatch(/^compiled\/_chunks\/client\//);
  });

  it("keeps Zod out of public declarations outside the shrinking allowlist", async () => {
    const pending = Object.values(await readPackageExports())
      .map((target) => (typeof target === "string" ? undefined : target.types))
      .filter((target): target is string => target?.endsWith(".d.ts") === true)
      .map((target) => join(EVE_PACKAGE_ROOT, target));
    const visited = new Set<string>();
    const withZodTypes: string[] = [];

    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (visited.has(file) || file.startsWith(join(DIST_SRC, "compiled"))) continue;
      visited.add(file);
      const source = stripComments(await readFile(file, "utf8"));
      if (ZOD_DECLARATION_IMPORT.test(source)) {
        withZodTypes.push(relative(DIST_SRC, file).split(sep).join("/"));
      }
      for (const [, specifier] of source.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g,
      )) {
        const declaration = specifier && resolveDeclaration(file, specifier);
        if (declaration) pending.push(declaration);
      }
    }

    expect(visited.size).toBeGreaterThan(100);
    expect(withZodTypes.sort()).toEqual(PUBLIC_DECLARATIONS_WITH_ZOD_TYPES);
  });
});
