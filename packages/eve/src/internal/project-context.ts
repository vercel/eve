import { join, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import {
  resolveAgentWorkspace,
  type AgentWorkspace,
  type AgentWorkspaceMember,
} from "#internal/agent-workspace.js";

export type EveProjectContext =
  | {
      readonly workspace: AgentWorkspace;
      readonly environmentRoot: string;
      readonly kind: "workspace";
    }
  | {
      readonly workspace: AgentWorkspace;
      readonly environmentRoot: string;
      readonly kind: "workspace-member";
      readonly member: AgentWorkspaceMember;
    }
  | {
      readonly appRoot: string;
      readonly environmentRoot: string;
      readonly kind: "standalone";
    };

function standalone(appRoot: string): Extract<EveProjectContext, { kind: "standalone" }> {
  return { appRoot, environmentRoot: appRoot, kind: "standalone" };
}

/** Classify an app root included by the nearest declared agent workspace. */
export async function resolveNamedAgentProjectContext(
  appRoot: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<Extract<EveProjectContext, { kind: "workspace-member" | "standalone" }> | undefined> {
  const resolvedAppRoot = resolve(appRoot);
  const source = options.source ?? createDiskProjectSource();
  let workspaceRoot = resolvedAppRoot;

  while (true) {
    if (
      workspaceRoot !== resolvedAppRoot &&
      (await source.stat(join(workspaceRoot, "agent"))) === "directory"
    ) {
      return undefined;
    }
    const workspace = await resolveAgentWorkspace(workspaceRoot, { source });
    const member = workspace?.members.find((candidate) => candidate.appRoot === resolvedAppRoot);
    if (workspace !== undefined && member !== undefined) {
      return {
        workspace,
        environmentRoot: workspace.root,
        kind: "workspace-member",
        member,
      };
    }

    const parent = resolve(workspaceRoot, "..");
    if (parent === workspaceRoot) return undefined;
    workspaceRoot = parent;
  }
}

/** Classify the current filesystem scope before command-specific policy runs. */
export async function resolveEveProjectContext(
  appRoot: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<EveProjectContext> {
  const resolvedAppRoot = resolve(appRoot);
  const source = options.source ?? createDiskProjectSource();
  const namedAgent = await resolveNamedAgentProjectContext(resolvedAppRoot, { source });
  if (namedAgent !== undefined) return namedAgent;

  const workspace = await resolveAgentWorkspace(resolvedAppRoot, { source });
  return workspace === undefined
    ? standalone(resolvedAppRoot)
    : { workspace, environmentRoot: workspace.root, kind: "workspace" };
}
