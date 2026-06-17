// Build-time generator for the setup island's Web Chat template. Reads the
// `apps/templates/web-chat-next` source app, applies the declared scaffold transforms,
// and writes `scaffold/create/web-template.ts`. Not part of the shipped package: it is
// excluded from tsconfig.build.json and run on demand via the package scripts
// `generate:web-template` (--write) and `check:web-template` (--check, drift).
//
// Version stamping is NOT handled here: eve's scripts/stamp-version-tokens.mjs
// walks the whole dist and stamps the scaffold's __*_VERSION__ tokens for free.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SETUP_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SETUP_ROOT, "../../../..");
const SOURCE_ROOT = join(REPO_ROOT, "apps/templates/web-chat-next");
const OUTPUT_PATH = join(SETUP_ROOT, "scaffold/create/web-template.ts");

const SOURCE_ONLY_ROOT_ENTRIES = new Set([
  "README.md",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vercel.json",
]);
const WEB_CHANNEL_SOURCE_PATH = "agent/channels/eve.ts";

const FILE_TRANSFORMS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  "app/_components/agent-chat.tsx": [
    ['const AGENT_NAME = "eve-agent";', 'const AGENT_NAME = "__EVE_INIT_APP_NAME__";'],
  ],
  "app/layout.tsx": [['  title: "eve Next.js Starter",', '  title: "__EVE_INIT_APP_NAME__",']],
  "next.config.ts": [
    [
      "export default withEve(nextConfig);",
      "export default withEve(nextConfig__EVE_INIT_WITH_EVE_OPTIONS__);",
    ],
  ],
};

function applyDeclaredTransforms(relativePath: string, source: string): string {
  let content = source;
  for (const [before, after] of FILE_TRANSFORMS[relativePath] ?? []) {
    const firstIndex = content.indexOf(before);
    const lastIndex = content.lastIndexOf(before);
    if (firstIndex < 0 || firstIndex !== lastIndex) {
      throw new Error(
        `Expected one occurrence of ${JSON.stringify(before)} in ${relativePath}; update the declared scaffold transform.`,
      );
    }
    content = content.replace(before, after);
  }
  return content;
}

function shouldCopySourcePath(relativePath: string): boolean {
  const rootEntry = relativePath.split("/", 1)[0] ?? "";
  if (
    rootEntry.startsWith(".") ||
    SOURCE_ONLY_ROOT_ENTRIES.has(rootEntry) ||
    relativePath.endsWith(".tsbuildinfo")
  ) {
    return false;
  }
  return (
    !relativePath.startsWith("agent/") ||
    relativePath === WEB_CHANNEL_SOURCE_PATH ||
    WEB_CHANNEL_SOURCE_PATH.startsWith(`${relativePath}/`)
  );
}

async function discoverSourceFiles(relativeDirectory = ""): Promise<string[]> {
  const entries = await readdir(join(SOURCE_ROOT, relativeDirectory), { withFileTypes: true });
  const discoveredFiles: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (!shouldCopySourcePath(relativePath)) continue;

    if (entry.isDirectory()) {
      discoveredFiles.push(...(await discoverSourceFiles(relativePath)));
    } else if (entry.isFile()) {
      discoveredFiles.push(relativePath);
    }
  }

  return discoveredFiles;
}

function quoteSourceFile(content: string): string {
  return `'${content
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")}'`;
}

function renderFileEntry(relativePath: string, content: string): string {
  const key = JSON.stringify(relativePath);
  const value = quoteSourceFile(content);
  const inline = `  ${key}: ${value},`;
  return inline.length <= 100 ? inline : `  ${key}:\n    ${value},`;
}

function renderPropertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function renderStringRecord(name: string, record: Record<string, string>): string {
  const values = Object.entries(record).map(
    ([key, value]) => `    ${renderPropertyKey(key)}: ${JSON.stringify(value)},`,
  );
  return [`  ${name}: {`, ...values, "  },"].join("\n");
}

interface PackageTemplate {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function parsePackageTemplate(source: string): PackageTemplate {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("apps/templates/web-chat-next/package.json must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  const fields = ["scripts", "dependencies", "devDependencies"] as const;
  for (const field of fields) {
    if (typeof record[field] !== "object" || record[field] === null) {
      throw new Error(`apps/templates/web-chat-next/package.json must define ${field}.`);
    }
  }
  return {
    scripts: record.scripts as Record<string, string>,
    dependencies: record.dependencies as Record<string, string>,
    devDependencies: record.devDependencies as Record<string, string>,
  };
}

async function renderGeneratedModule(): Promise<string> {
  const sourceFiles = await discoverSourceFiles();
  const entries = await Promise.all(
    sourceFiles.map(async (relativePath) => {
      const source = await readFile(join(SOURCE_ROOT, relativePath), "utf8");
      return renderFileEntry(relativePath, applyDeclaredTransforms(relativePath, source));
    }),
  );
  const packageTemplate = parsePackageTemplate(
    await readFile(join(SOURCE_ROOT, "package.json"), "utf8"),
  );

  return [
    "// Generated from apps/templates/web-chat-next by eve's setup build (src/setup/build.ts).",
    "// Do not edit directly. Edit the app or the declared generator transforms.",
    "",
    "export const WEB_APP_TEMPLATE_FILES = {",
    ...entries,
    "} as const;",
    "",
    "export const WEB_APP_TEMPLATE_PACKAGE_JSON = {",
    renderStringRecord("scripts", packageTemplate.scripts),
    renderStringRecord("dependencies", packageTemplate.dependencies),
    renderStringRecord("devDependencies", packageTemplate.devDependencies),
    "} as const;",
    "",
  ].join("\n");
}

const mode = process.argv[2] ?? "--write";
if (mode !== "--write" && mode !== "--check") {
  throw new Error("Usage: node src/setup/build.ts [--write|--check]");
}

const generated = await renderGeneratedModule();
if (mode === "--write") {
  await writeFile(OUTPUT_PATH, generated, "utf8");
} else {
  const current = await readFile(OUTPUT_PATH, "utf8");
  if (current !== generated) {
    process.stderr.write(
      "packages/eve/src/setup/scaffold/create/web-template.ts is stale. Run `pnpm --filter eve generate:web-template`.\n",
    );
    process.exitCode = 1;
  }
}
