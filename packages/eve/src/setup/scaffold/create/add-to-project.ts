import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PackageManagerKind } from "../../package-manager.js";
import type { NodeEngineOverride } from "../../node-engine.js";
import { pathExists, writeTextFile } from "../files.js";
import { patchPackageJson, type PackageJsonPatch } from "../update/package-json.js";
import { resolveVersionToken } from "../version-tokens.js";
import {
  applyPackageManagerWorkspaceConfiguration,
  isPackageManagerWorkspaceMember,
  patchWorkspaceRootPackageJson,
} from "../workspace-root.js";
import {
  agentTemplateFiles,
  DEFAULT_AI_PACKAGE_VERSION,
  DEFAULT_CONNECT_PACKAGE_VERSION,
  DEFAULT_ZOD_PACKAGE_VERSION,
  formatEveDependencySpecifier,
  resolveEvePackageContract,
  type EvePackageContract,
} from "./project.js";

export interface AddAgentToProjectOptions {
  projectRoot: string;
  model: string;
  /**
   * The host project's package manager, which owns any manager-specific
   * generated project configuration. Defaults to pnpm.
   */
  packageManager?: PackageManagerKind;
  evePackage?: EvePackageContract;
  aiPackageVersion?: string;
  connectPackageVersion?: string;
  zodPackageVersion?: string;
}

export interface AddAgentToProjectResult {
  filesWritten: string[];
  /** Dependencies added to package.json; ones the project already declares anywhere are left untouched. */
  dependenciesAdded: string[];
  /** Present when an incompatible package.json engines.node value was replaced. */
  nodeEngineOverride?: NodeEngineOverride;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDeclaredDependency(packageJson: unknown, dependencyName: string): boolean {
  if (!isJsonObject(packageJson)) return false;
  for (const field of DEPENDENCY_FIELDS) {
    const block = packageJson[field];
    if (isJsonObject(block) && typeof block[dependencyName] === "string") {
      return true;
    }
  }
  return false;
}

/**
 * Adds an eve agent to an existing package: writes the `agent/` files, adds
 * missing runtime dependencies, reconciles `engines.node` with eve's
 * requirement, and applies the selected package manager's project
 * configuration. Other host configuration (tsconfig, scripts, ignore files)
 * remains untouched. All conflicts are gathered and reported before anything
 * is written.
 */
export async function addAgentToProject(
  options: AddAgentToProjectOptions,
): Promise<AddAgentToProjectResult> {
  const packageManager = options.packageManager ?? "pnpm";
  const packageJsonPath = join(options.projectRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    throw new Error(
      `Cannot add an eve agent to "${options.projectRoot}" because it has no package.json. ` +
        "Run `eve init <name>` to create a new project instead.",
    );
  }

  const files = agentTemplateFiles(options.model);
  const conflicts: string[] = [];
  for (const relativePath of Object.keys(files)) {
    if (await pathExists(join(options.projectRoot, relativePath))) {
      conflicts.push(relativePath);
    }
  }
  if (conflicts.length === 0 && (await pathExists(join(options.projectRoot, "agent")))) {
    conflicts.push("agent/");
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Cannot add an eve agent to "${options.projectRoot}" because it already has: ` +
        `${conflicts.join(", ")}.`,
    );
  }

  const evePackage = resolveEvePackageContract(options.evePackage);
  const aiVersion = resolveVersionToken(
    "aiPackageVersion",
    options.aiPackageVersion ?? DEFAULT_AI_PACKAGE_VERSION,
  );
  // Channels and connections scaffolded later (`eve channels add slack`,
  // possibly while `eve dev` is running) import `@vercel/connect`; shipping
  // it from init means adding them never introduces a missing dependency.
  const connectVersion = resolveVersionToken(
    "connectPackageVersion",
    options.connectPackageVersion ?? DEFAULT_CONNECT_PACKAGE_VERSION,
  );
  const zodVersion = resolveVersionToken(
    "zodPackageVersion",
    options.zodPackageVersion ?? DEFAULT_ZOD_PACKAGE_VERSION,
  );

  const filesWritten: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(options.projectRoot, relativePath);
    await writeTextFile(filePath, content);
    filesWritten.push(filePath);
  }

  const packageJson: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const wanted: Record<string, string> = {
    "@vercel/connect": connectVersion,
    ai: aiVersion,
    eve: formatEveDependencySpecifier(evePackage.version),
    zod: zodVersion,
  };
  const additions: Record<string, string> = {};
  for (const [name, version] of Object.entries(wanted)) {
    if (!hasDeclaredDependency(packageJson, name)) {
      additions[name] = version;
    }
  }
  const patch: PackageJsonPatch = {};
  if (Object.keys(additions).length > 0) {
    patch.dependencies = additions;
  }
  const workspaceMember = isPackageManagerWorkspaceMember(packageManager, options.projectRoot);
  if (!workspaceMember) {
    patch.nodeEngineRequirement = evePackage.nodeEngine;
  }
  const patchResult = await patchPackageJson(packageJsonPath, patch);

  const workspacePatchResult = await patchWorkspaceRootPackageJson(
    packageManager,
    options.projectRoot,
    {
      aiPackageVersion: aiVersion,
      nodeEngineRequirement: evePackage.nodeEngine,
    },
  );
  const nodeEngineOverride =
    workspacePatchResult.nodeEngineOverride ?? patchResult.nodeEngineOverride;

  await applyPackageManagerWorkspaceConfiguration({
    packageManager,
    projectRoot: options.projectRoot,
  });

  return {
    filesWritten,
    dependenciesAdded: Object.keys(additions).sort(),
    nodeEngineOverride,
  };
}
