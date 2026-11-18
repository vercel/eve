import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  type AstNode,
  readAuthoredAst,
  stringLiteral,
  unwrapExpression,
  visitAst,
} from "#compiler/authored-ast.js";
import type { CompilerDiagnostic } from "#compiler/diagnostics.js";
import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledAgentManifest } from "#compiler/manifest.js";
import { getSupportedModuleBaseName, isAuthoredTestPath } from "#discover/filesystem.js";

export const PROJECT_BUILD_SCRIPT_SKIPS_EVE = "project/build-script-skips-eve";

export const PROJECT_NEXT_CONFIG_MISSING_WITH_EVE = "project/next-config-missing-with-eve";

export const PROJECT_ENV_VAR_UNDOCUMENTED = "project/env-var-undocumented";

export const PROJECT_AGENT_FILES_OUTSIDE_AGENT_ROOT = "project/agent-files-outside-agent-root";

const NEXT_CONFIG_FILE_NAMES = [
  "next.config.ts",
  "next.config.mts",
  "next.config.js",
  "next.config.mjs",
];

const AGENT_SOURCE_DIRECTORY_NAMES = ["channels", "connections", "skills", "subagents", "tools"];

const PLATFORM_ENV_VAR_PATTERN = /^(?:CI|EVE_.*|NODE_ENV|PORT|VERCEL(?:_.*)?)$/;

export async function diagnoseProject(
  manifest: CompiledAgentManifest,
): Promise<CompilerDiagnostic[]> {
  const appRoot = manifest.appRoot;
  const entries = await readDirectoryNames(appRoot);
  return [
    ...(await diagnoseBuildScript(appRoot)),
    ...(await diagnoseNextConfig(appRoot, entries)),
    ...(entries.has(".env.example") ? await diagnoseUndocumentedEnvVars(manifest) : []),
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

async function diagnoseUndocumentedEnvVars(
  manifest: CompiledAgentManifest,
): Promise<CompilerDiagnostic[]> {
  const examplePath = join(manifest.appRoot, ".env.example");
  const documented = new Set(
    (await readFile(examplePath, "utf8"))
      .split("\n")
      .map((line) => /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((name) => name !== undefined),
  );
  const sourcePaths = await listAuthoredModules(manifest.agentRoot);
  const diagnostics: CompilerDiagnostic[] = [];
  for (const sourcePath of sourcePaths) {
    const undocumented = (await readRequiredEnvVars(sourcePath)).filter(
      (name) => !documented.has(name) && !PLATFORM_ENV_VAR_PATTERN.test(name),
    );
    if (undocumented.length === 0) continue;
    diagnostics.push(
      warning(
        PROJECT_ENV_VAR_UNDOCUMENTED,
        `"${relative(manifest.appRoot, sourcePath)}" requires ${undocumented.map((name) => `process.env.${name}`).join(", ")}, but .env.example doesn't list ${undocumented.length === 1 ? "it" : "them"}, so a fresh setup won't know to set ${undocumented.length === 1 ? "it" : "them"}. Add ${undocumented.length === 1 ? "it" : "them"} to .env.example, or give a fallback if ${undocumented.length === 1 ? "it's" : "they're"} optional.`,
        sourcePath,
      ),
    );
  }
  return diagnostics;
}

async function readRequiredEnvVars(sourcePath: string): Promise<string[]> {
  const ast = await readAuthoredAst(sourcePath, "process.env");
  const aliases = new Map<string, string>();
  visitAst(ast, (node) => {
    const id = node.id as AstNode | undefined;
    const name = envVarName(unwrapExpression(node.init));
    if (node.type === "VariableDeclarator" && id?.type === "Identifier" && name !== undefined) {
      aliases.set(id.name as string, name);
    }
  });
  const readEnv = (node: unknown): string | undefined => {
    const value = unwrapExpression(node);
    return value?.type === "Identifier" ? aliases.get(value.name as string) : envVarName(value);
  };
  const required = new Set<string>();
  visitAst(ast, (node) => {
    if (node.type === "TSNonNullExpression") {
      const name = envVarName(unwrapExpression(node.expression));
      if (name !== undefined) required.add(name);
    }
    if (node.type === "IfStatement" && throwsFirst(node.consequent)) {
      visitAst(node.test, (test) => {
        if (test.type !== "UnaryExpression" || test.operator !== "!") return;
        const name = readEnv(test.argument);
        if (name !== undefined) required.add(name);
      });
    }
  });
  return [...required].sort();
}

function throwsFirst(statement: unknown): boolean {
  const node = statement as AstNode | undefined;
  if (node?.type === "ThrowStatement") return true;
  const [first] = (node?.type === "BlockStatement" ? (node.body as readonly AstNode[]) : []) ?? [];
  return first?.type === "ThrowStatement";
}

function envVarName(node: AstNode | undefined): string | undefined {
  if (node?.type !== "MemberExpression") return undefined;
  const object = unwrapExpression(node.object);
  const env = object?.type === "MemberExpression" ? object : undefined;
  const processNode = unwrapExpression(env?.object);
  if (
    processNode?.type !== "Identifier" ||
    processNode.name !== "process" ||
    env?.computed === true ||
    (env?.property as AstNode | undefined)?.name !== "env"
  ) {
    return undefined;
  }
  return node.computed === true
    ? stringLiteral(node.property)
    : ((node.property as AstNode | undefined)?.name as string | undefined);
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

async function listAuthoredModules(directoryPath: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directoryPath, { withFileTypes: true }).catch(() => [])) {
    const path = join(directoryPath, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
      paths.push(...(await listAuthoredModules(path)));
    } else if (
      entry.isFile() &&
      getSupportedModuleBaseName(entry.name) !== null &&
      !isAuthoredTestPath(path)
    ) {
      paths.push(path);
    }
  }
  return paths.sort();
}

async function readDirectoryNames(directoryPath: string): Promise<Set<string>> {
  return new Set(await readdir(directoryPath).catch(() => []));
}
