import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PackageManagerKind } from "../../package-manager.js";
import type { NodeEngineOverride } from "../../node-engine.js";
import type { AgentReasoningDefinition } from "../../../shared/agent-definition.js";
import { pathExists } from "../files.js";
import {
  applyFileWritePlan,
  planFileWrite,
  type AppliedFileWrite,
  type PlannedFileWrite,
} from "../bounded-write-plan.js";
import { preparePackageJsonPatch, type PackageJsonPatch } from "../update/package-json.js";
import { resolveVersionToken } from "../version-tokens.js";
import { preparePnpmWorkspacePolicy } from "../../primitives/pm/pnpm.js";
import {
  isPackageManagerWorkspaceMember,
  packageManagerRootOnlyPackageJsonPatch,
  workspaceRootPackageJsonPath,
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
  reasoning?: AgentReasoningDefinition;
  packageManager?: PackageManagerKind;
  evePackage?: EvePackageContract;
  aiPackageVersion?: string;
  connectPackageVersion?: string;
  zodPackageVersion?: string;
}

export interface AddAgentToProjectPlan {
  dependenciesAdded: readonly string[];
  nodeEngineOverride?: NodeEngineOverride;
  projectRoot: string;
  summary: readonly string[];
  writes: readonly PlannedFileWrite[];
}

export interface AddAgentToProjectResult {
  appliedWrites: readonly AppliedFileWrite[];
  filesWritten: string[];
  dependenciesAdded: string[];
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
  return DEPENDENCY_FIELDS.some((field) => {
    const block = packageJson[field];
    return isJsonObject(block) && typeof block[dependencyName] === "string";
  });
}

export async function planAddAgentToProject(
  options: AddAgentToProjectOptions,
): Promise<AddAgentToProjectPlan> {
  const packageManager = options.packageManager ?? "pnpm";
  const packageJsonPath = join(options.projectRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    throw new Error(
      `Cannot add an eve agent to "${options.projectRoot}" because it has no package.json.`,
    );
  }

  let packageJsonRaw: string;
  let packageJson: unknown;
  try {
    packageJsonRaw = await readFile(packageJsonPath, "utf8");
    packageJson = JSON.parse(packageJsonRaw);
  } catch (error) {
    throw new Error(
      `Cannot add an eve agent because "${packageJsonPath}" is not valid JSON. No files were changed. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const files = agentTemplateFiles(options.model, options.reasoning);
  const conflicts = (
    await Promise.all(
      Object.keys(files).map(async (relativePath) =>
        (await pathExists(join(options.projectRoot, relativePath))) ? relativePath : undefined,
      ),
    )
  ).filter((path): path is string => path !== undefined);
  if (conflicts.length === 0 && (await pathExists(join(options.projectRoot, "agent")))) {
    conflicts.push("agent/");
  }
  if (conflicts.length > 0) {
    throw new Error(`Cannot add an eve agent because it already has: ${conflicts.join(", ")}.`);
  }

  const evePackage = resolveEvePackageContract(options.evePackage);
  const aiVersion = resolveVersionToken(
    "aiPackageVersion",
    options.aiPackageVersion ?? DEFAULT_AI_PACKAGE_VERSION,
  );
  const connectVersion = resolveVersionToken(
    "connectPackageVersion",
    options.connectPackageVersion ?? DEFAULT_CONNECT_PACKAGE_VERSION,
  );
  const zodVersion = resolveVersionToken(
    "zodPackageVersion",
    options.zodPackageVersion ?? DEFAULT_ZOD_PACKAGE_VERSION,
  );
  const wanted = {
    "@vercel/connect": connectVersion,
    ai: aiVersion,
    eve: formatEveDependencySpecifier(evePackage.version),
    zod: zodVersion,
  };
  const additions = Object.fromEntries(
    Object.entries(wanted).filter(([name]) => !hasDeclaredDependency(packageJson, name)),
  );
  const patch: PackageJsonPatch = {};
  if (Object.keys(additions).length > 0) patch.dependencies = additions;
  if (!isPackageManagerWorkspaceMember(packageManager, options.projectRoot)) {
    patch.nodeEngineRequirement = evePackage.nodeEngine;
  }
  const preparedPackageJson = preparePackageJsonPatch(packageJsonRaw, patch);
  const workspacePackageJsonPath = workspaceRootPackageJsonPath(
    packageManager,
    options.projectRoot,
  );
  const workspacePackageJsonBefore =
    workspacePackageJsonPath === undefined
      ? undefined
      : await readFile(workspacePackageJsonPath, "utf8");
  const preparedWorkspacePackageJson =
    workspacePackageJsonBefore === undefined
      ? undefined
      : preparePackageJsonPatch(
          workspacePackageJsonBefore,
          packageManagerRootOnlyPackageJsonPatch(packageManager, {
            aiPackageVersion: aiVersion,
            nodeEngineRequirement: evePackage.nodeEngine,
          }),
        );
  const pnpmWorkspacePath = join(options.projectRoot, "pnpm-workspace.yaml");
  const pnpmWorkspaceBefore =
    packageManager === "pnpm" &&
    !isPackageManagerWorkspaceMember(packageManager, options.projectRoot)
      ? await readFile(pnpmWorkspacePath, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })
      : undefined;
  const pnpmWorkspaceAfter =
    packageManager === "pnpm" &&
    !isPackageManagerWorkspaceMember(packageManager, options.projectRoot)
      ? preparePnpmWorkspacePolicy(pnpmWorkspaceBefore)
      : undefined;
  const writes = await Promise.all([
    ...Object.entries(files).map(([relativePath, content]) =>
      planFileWrite({
        bytes: Buffer.from(content),
        destination: join(options.projectRoot, relativePath),
        root: options.projectRoot,
      }),
    ),
    ...(preparedPackageJson.changed
      ? [
          planFileWrite({
            bytes: preparedPackageJson.bytes,
            destination: packageJsonPath,
            root: options.projectRoot,
          }),
        ]
      : []),
    ...(preparedWorkspacePackageJson?.changed === true && workspacePackageJsonPath !== undefined
      ? [
          planFileWrite({
            bytes: preparedWorkspacePackageJson.bytes,
            destination: workspacePackageJsonPath,
            root: join(workspacePackageJsonPath, ".."),
          }),
        ]
      : []),
    ...(pnpmWorkspaceAfter !== undefined && pnpmWorkspaceAfter !== pnpmWorkspaceBefore
      ? [
          planFileWrite({
            bytes: Buffer.from(pnpmWorkspaceAfter),
            destination: pnpmWorkspacePath,
            root: options.projectRoot,
          }),
        ]
      : []),
  ]);
  const dependenciesAdded = Object.keys(additions).sort();
  return {
    dependenciesAdded,
    nodeEngineOverride: preparedPackageJson.nodeEngineOverride,
    projectRoot: options.projectRoot,
    summary: [
      ...Object.keys(files).map((path) => `Create ${path}`),
      ...(dependenciesAdded.length === 0
        ? []
        : [`Add dependencies: ${dependenciesAdded.join(", ")}`]),
      ...(preparedPackageJson.nodeEngineOverride === undefined
        ? []
        : [`Update package.json engines.node to ${preparedPackageJson.nodeEngineOverride.next}`]),
      ...(preparedWorkspacePackageJson?.changed === true
        ? [`Update workspace package.json at ${workspacePackageJsonPath}`]
        : []),
      ...(pnpmWorkspaceAfter !== undefined && pnpmWorkspaceAfter !== pnpmWorkspaceBefore
        ? ["Update pnpm-workspace.yaml package policy"]
        : []),
    ],
    writes,
  };
}

export async function applyAddAgentToProjectPlan(
  plan: AddAgentToProjectPlan,
): Promise<AddAgentToProjectResult> {
  const appliedWrites = await applyFileWritePlan(plan.projectRoot, plan.writes);
  return {
    appliedWrites,
    dependenciesAdded: [...plan.dependenciesAdded],
    filesWritten: appliedWrites.map((write) => write.destination),
    nodeEngineOverride: plan.nodeEngineOverride,
  };
}

export async function addAgentToProject(
  options: AddAgentToProjectOptions,
): Promise<AddAgentToProjectResult> {
  return applyAddAgentToProjectPlan(await planAddAgentToProject(options));
}
