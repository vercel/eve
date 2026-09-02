import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  findClaimingAncestorPnpmWorkspaceRoot,
  PNPM_WORKSPACE_PATH,
} from "#setup/primitives/pm/pnpm.js";

export type PnpmBuildPolicyAction = "ignore-optional" | "allow-builds";

export interface PnpmBuildPolicyContext {
  readonly filePath: string;
  readonly packages: readonly string[];
  readonly satisfied: boolean;
}

type PolicyBlockKind = "mapping" | "sequence";

function blockRange(
  lines: readonly string[],
  key: string,
): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start < 0) return undefined;
  if (!new RegExp(`^${key}:\\s*(?:#.*)?$`).test(lines[start] ?? "")) {
    throw new Error(
      `Cannot safely update ${key} because it does not use block-style YAML in ${PNPM_WORKSPACE_PATH}.`,
    );
  }
  let end = start + 1;
  while (end < lines.length && !/^\S/u.test(lines[end] ?? "")) end += 1;
  return { start, end };
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function mappingEntry(line: string): { key: string; value: boolean } | undefined {
  const match =
    /^\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#][^:]*?):\s*(true|false)\s*(?:#.*)?$/u.exec(line);
  if (match === null) return undefined;
  return { key: unquoteYamlScalar(match[1]!), value: match[2] === "true" };
}

function sequenceEntry(line: string): string | undefined {
  const match = /^\s+-\s+(.*?)(?:\s+#.*)?$/u.exec(line);
  return match === null ? undefined : unquoteYamlScalar(match[1]!);
}

function policyEntries(
  lines: readonly string[],
  key: string,
  kind: PolicyBlockKind,
): ReadonlyMap<string, boolean> {
  const range = blockRange(lines, key);
  const entries = new Map<string, boolean>();
  if (range === undefined) return entries;
  for (const line of lines.slice(range.start + 1, range.end)) {
    if (kind === "mapping") {
      const entry = mappingEntry(line);
      if (entry !== undefined) entries.set(entry.key, entry.value);
    } else {
      const entry = sequenceEntry(line);
      if (entry !== undefined) entries.set(entry, true);
    }
  }
  return entries;
}

function removePolicyEntries(
  lines: string[],
  key: string,
  kind: PolicyBlockKind,
  packages: ReadonlySet<string>,
): void {
  const range = blockRange(lines, key);
  if (range === undefined) return;
  for (let index = range.end - 1; index > range.start; index -= 1) {
    const packageName =
      kind === "mapping"
        ? mappingEntry(lines[index] ?? "")?.key
        : sequenceEntry(lines[index] ?? "");
    if (packageName !== undefined && packages.has(packageName)) lines.splice(index, 1);
  }
  const updated = blockRange(lines, key);
  if (updated === undefined) return;
  const hasEntry = lines
    .slice(updated.start + 1, updated.end)
    .some((line) => (kind === "mapping" ? mappingEntry(line) : sequenceEntry(line)) !== undefined);
  if (!hasEntry) {
    const comments = lines
      .slice(updated.start + 1, updated.end)
      .filter((line) => line.trimStart().startsWith("#"));
    lines.splice(updated.start, updated.end - updated.start, ...comments);
  }
}

function appendPolicyEntries(
  lines: string[],
  key: string,
  kind: PolicyBlockKind,
  packages: readonly string[],
): void {
  let range = blockRange(lines, key);
  if (range === undefined) {
    while (lines.at(-1) === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(`${key}:`);
    range = { start: lines.length - 1, end: lines.length };
  }
  const existing = policyEntries(lines, key, kind);
  const missing = packages.filter((packageName) => !existing.has(packageName));
  if (missing.length === 0) return;
  const insertion = missing.map((packageName) =>
    kind === "mapping"
      ? `  ${JSON.stringify(packageName)}: true`
      : `  - ${JSON.stringify(packageName)}`,
  );
  lines.splice(range.end, 0, ...insertion);
}

/** Applies one explicit pnpm build policy while preserving unrelated workspace settings. */
export function withPnpmBuildPolicy(
  source: string,
  packages: readonly string[],
  action: PnpmBuildPolicyAction,
): string {
  const normalizedPackages = [...new Set(packages)].sort();
  const packageSet = new Set(normalizedPackages);
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  removePolicyEntries(lines, "allowBuilds", "mapping", packageSet);
  removePolicyEntries(lines, "ignoredOptionalDependencies", "sequence", packageSet);
  if (action === "allow-builds") {
    appendPolicyEntries(lines, "allowBuilds", "mapping", normalizedPackages);
  } else {
    appendPolicyEntries(lines, "ignoredOptionalDependencies", "sequence", normalizedPackages);
  }
  while (lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

async function readWorkspacePolicy(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function owningPnpmWorkspaceRoot(appRoot: string): Promise<string> {
  try {
    await access(join(appRoot, PNPM_WORKSPACE_PATH));
    return appRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return findClaimingAncestorPnpmWorkspaceRoot(appRoot) ?? appRoot;
}

/** Resolves whether every package already has an explicit non-blocking pnpm policy. */
export async function inspectPnpmBuildPolicy(
  appRoot: string,
  packages: readonly string[],
): Promise<PnpmBuildPolicyContext> {
  const workspaceRoot = await owningPnpmWorkspaceRoot(appRoot);
  const filePath = join(workspaceRoot, PNPM_WORKSPACE_PATH);
  const source = await readWorkspacePolicy(filePath);
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const allowed = policyEntries(lines, "allowBuilds", "mapping");
  const ignored = policyEntries(lines, "ignoredOptionalDependencies", "sequence");
  return {
    filePath,
    packages,
    satisfied: packages.every(
      (packageName) => allowed.get(packageName) === true || ignored.has(packageName),
    ),
  };
}

/** Persists the policy selected before the registry installation transaction begins. */
export async function applyPnpmBuildPolicy(
  context: PnpmBuildPolicyContext,
  action: PnpmBuildPolicyAction,
): Promise<void> {
  const source = await readWorkspacePolicy(context.filePath);
  await writeFile(context.filePath, withPnpmBuildPolicy(source, context.packages, action), "utf8");
}
