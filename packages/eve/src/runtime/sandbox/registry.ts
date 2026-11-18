import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

export interface RuntimeRegisteredSandbox {
  readonly definition: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly inheritance?: {
    readonly definition: ResolvedSandboxDefinition;
    readonly nodeId: string;
    readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  };
}

export function owningSandboxDefinition(
  sandbox: RuntimeRegisteredSandbox,
): ResolvedSandboxDefinition {
  return sandbox.inheritance?.definition ?? sandbox.definition;
}

export interface RuntimeSandboxRegistry {
  readonly sandbox: RuntimeRegisteredSandbox;
}

export function createRuntimeSandboxRegistry(input: {
  readonly sandbox: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): RuntimeSandboxRegistry {
  const definition = input.sandbox;
  if (
    definition.kind === "parent" &&
    (input.workspaceResourceRoot.contentHash !== undefined ||
      input.workspaceResourceRoot.rootEntries.length > 0)
  ) {
    throw new Error(
      `Sandbox "${definition.logicalPath}" selects parent.sandbox but has managed workspace resources. Remove the child workspace or give the child its own sandbox.`,
    );
  }
  return {
    sandbox: {
      definition,
      workspaceResourceRoot: input.workspaceResourceRoot,
    },
  };
}
