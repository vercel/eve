import { resolve } from "node:path";

import { findEveProjectContext, type EveProjectContext } from "#internal/project-context.js";
import { resolveEvePackageContract } from "#setup/scaffold/create/project.js";

import {
  collectDependencyFacts,
  collectDiscoveryFacts,
  collectGitFacts,
  collectNodeFacts,
  collectPackageManagerFacts,
  collectVercelFacts,
} from "./collectors.js";
import {
  dependencyDiagnostic,
  discoveryDiagnostic,
  gitDiagnostics,
  nodeDiagnostic,
  packageManagerDiagnostic,
  vercelDiagnostic,
} from "./policies.js";
import type { Diagnostic, DiagnosticStatus } from "./types.js";

export interface DoctorAgentResult {
  readonly appRoot: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly name: string;
}

export interface DoctorResult {
  readonly agents: readonly DoctorAgentResult[];
  readonly diagnostics: readonly Diagnostic[];
  readonly scope: "standalone" | "workspace";
  readonly summary: Record<DiagnosticStatus, number>;
  readonly workspaceRoot: string | null;
}

function summarize(diagnostics: readonly Diagnostic[]): Record<DiagnosticStatus, number> {
  return diagnostics.reduce<Record<DiagnosticStatus, number>>(
    (summary, diagnostic) => {
      summary[diagnostic.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0, unknown: 0 },
  );
}

async function inspectAgent(name: string, appRoot: string): Promise<DoctorAgentResult> {
  return {
    name,
    appRoot,
    diagnostics: [discoveryDiagnostic(await collectDiscoveryFacts(appRoot))],
  };
}

function selectedAgents(
  context: EveProjectContext,
): readonly { readonly appRoot: string; readonly name: string }[] {
  if (context.kind === "workspace") return context.workspace.members;
  if (context.kind === "workspace-member") return [context.member];
  return [];
}

export async function runDoctor(
  path: string,
  options: { readonly offline?: boolean } = {},
): Promise<DoctorResult> {
  const resolvedPath = resolve(path);
  let context: EveProjectContext | undefined;
  let contextError: unknown;
  try {
    context = await findEveProjectContext(resolvedPath);
  } catch (error) {
    contextError = error;
  }

  const root =
    context?.kind === "workspace" || context?.kind === "workspace-member"
      ? context.workspace.root
      : context?.appRoot;
  const diagnostics: Diagnostic[] = [
    nodeDiagnostic(collectNodeFacts(), resolveEvePackageContract().nodeEngine),
  ];

  if (context === undefined || root === undefined) {
    diagnostics.push(
      contextError === undefined
        ? discoveryDiagnostic(await collectDiscoveryFacts(resolvedPath))
        : {
            id: "project.discovery",
            status: "fail",
            summary: contextError instanceof Error ? contextError.message : String(contextError),
            remediation: [{ kind: "command", command: "eve init <path>" }],
          },
    );
    return {
      agents: [],
      diagnostics,
      scope: "standalone",
      summary: summarize(diagnostics),
      workspaceRoot: null,
    };
  }

  const [packageManager, git, vercel, agents] = await Promise.all([
    collectPackageManagerFacts(root),
    collectGitFacts(root),
    collectVercelFacts(root, options.offline === true),
    Promise.all(selectedAgents(context).map(({ name, appRoot }) => inspectAgent(name, appRoot))),
  ]);
  const dependencies = await collectDependencyFacts(root, packageManager);
  diagnostics.push({
    id: "project.discovery",
    status: "pass",
    summary:
      context.kind === "workspace" || context.kind === "workspace-member"
        ? `Found eve workspace at ${root}.`
        : `Found eve project at ${root}.`,
    remediation: [],
  });
  diagnostics.push(packageManagerDiagnostic(packageManager));
  diagnostics.push(
    dependencyDiagnostic(
      dependencies,
      packageManager.kind === "observed" ? packageManager.manager : "pnpm",
    ),
  );
  diagnostics.push(vercelDiagnostic(vercel));
  diagnostics.push(...gitDiagnostics(git));
  const allDiagnostics = [...diagnostics, ...agents.flatMap((agent) => agent.diagnostics)];
  return {
    agents,
    diagnostics,
    scope: context.kind === "standalone" ? "standalone" : "workspace",
    summary: summarize(allDiagnostics),
    workspaceRoot: context.kind === "standalone" ? null : root,
  };
}
