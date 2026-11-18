import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { CompilerDiagnostic } from "#compiler/diagnostics.js";
import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledAgentManifest } from "#compiler/manifest.js";
import { getSupportedModuleBaseName } from "#discover/filesystem.js";

export const PROJECT_BUILD_SCRIPT_SKIPS_EVE = "project/build-script-skips-eve";

export const PROJECT_NEXT_CONFIG_MISSING_WITH_EVE = "project/next-config-missing-with-eve";

export const PROJECT_AGENT_FILES_OUTSIDE_AGENT_ROOT = "project/agent-files-outside-agent-root";

const NEXT_CONFIG_FILE_NAMES = [
  "next.config.ts",
  "next.config.mts",
  "next.config.js",
  "next.config.mjs",
];

const AGENT_SOURCE_DIRECTORY_NAMES = ["channels", "connections", "skills", "subagents", "tools"];

export async function diagnoseProject(
  manifest: CompiledAgentManifest,
): Promise<CompilerDiagnostic[]> {
  const appRoot = manifest.appRoot;
  const entries = await readDirectoryNames(appRoot);
  return [
    ...(await diagnoseBuildScript(appRoot)),
    ...(await diagnoseNextConfig(appRoot, entries)),
    ...(entries.has("src") && join(appRoot, "src") !== manifest.agentRoot
      ? await diagnoseAgentFilesInSrc(appRoot, manifest.agentRoot)
      : []),
  ];
}

function warning(code: string, message: string, sourcePath: string): CompilerDiagnostic {
  return {
    code,
    message,
    severity: "warning",
    sources: [{ nodeId: ROOT_COMPILED_AGENT_NODE_ID, sourcePath }],
  };
}

async function diagnoseBuildScript(appRoot: string): Promise<CompilerDiagnostic[]> {
  const packageJsonPath = join(appRoot, "package.json");
  const build = await readFile(packageJsonPath, "utf8")
    .then((text) => (JSON.parse(text) as { scripts?: { build?: unknown } }).scripts?.build)
    .catch(() => undefined);
  if (typeof build !== "string") return [];
  const commands = build.split(/&&|\|\||;/).map((command) => command.trim());
  if (commands.length === 0 || !commands.every((command) => /^tsc(?:\s|$)/.test(command))) {
    return [];
  }
  return [
    warning(
      PROJECT_BUILD_SCRIPT_SKIPS_EVE,
      `package.json "build" runs ${JSON.stringify(build)}, which only compiles TypeScript and doesn't build the agent. Use "eve build", or "tsc --noEmit && eve build" to keep the type check.`,
      packageJsonPath,
    ),
  ];
}

async function diagnoseNextConfig(
  appRoot: string,
  entries: ReadonlySet<string>,
): Promise<CompilerDiagnostic[]> {
  const configName = NEXT_CONFIG_FILE_NAMES.find((name) => entries.has(name));
  if (configName === undefined || entries.has("vercel.ts")) return [];
  const configPath = join(appRoot, configName);
  if ((await readFile(configPath, "utf8")).includes("withEve")) return [];
  return [
    warning(
      PROJECT_NEXT_CONFIG_MISSING_WITH_EVE,
      `${configName} doesn't wrap its config in withEve() from "eve/next", so next dev and next build won't serve the agent. Export withEve(nextConfig) instead.`,
      configPath,
    ),
  ];
}

async function diagnoseAgentFilesInSrc(
  appRoot: string,
  agentRoot: string,
): Promise<CompilerDiagnostic[]> {
  const srcPath = join(appRoot, "src");
  const found: string[] = [];
  for (const entry of await readdir(srcPath, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && getSupportedModuleBaseName(entry.name) === "agent") {
      found.push(`src/${entry.name}`);
    }
    if (
      entry.isDirectory() &&
      AGENT_SOURCE_DIRECTORY_NAMES.includes(entry.name) &&
      (await importsEve(join(srcPath, entry.name)))
    ) {
      found.push(`src/${entry.name}/`);
    }
  }
  if (found.length === 0) return [];
  return [
    warning(
      PROJECT_AGENT_FILES_OUTSIDE_AGENT_ROOT,
      `Found agent sources at ${found.map((path) => `"${path}"`).join(", ")}, but eve reads the agent from "${relative(appRoot, agentRoot) || "."}/" and ignores src/. Move them into "${relative(appRoot, agentRoot) || "."}/".`,
      srcPath,
    ),
  ];
}

async function importsEve(directoryPath: string): Promise<boolean> {
  for (const entry of await readdir(directoryPath, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || getSupportedModuleBaseName(entry.name) === null) continue;
    const source = await readFile(join(directoryPath, entry.name), "utf8");
    if (/from\s+["']eve(?:\/[^"']*)?["']/.test(source)) return true;
  }
  return false;
}

async function readDirectoryNames(directoryPath: string): Promise<Set<string>> {
  return new Set(await readdir(directoryPath).catch(() => []));
}
