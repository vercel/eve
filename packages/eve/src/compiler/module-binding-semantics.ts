import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  AgentSourceOwner,
  CompiledModuleBacking,
  CompiledModuleBinding,
} from "#compiler/module-binding.js";
import {
  FRAMEWORK_AGENT_SOURCE_ID,
  FRAMEWORK_ROOT_AGENT_SOURCE_ID,
} from "#framework-sources/constants.js";
import { packageStateNamespace } from "#shared/extension-state-namespace.js";

/** Validates owner-specific invariants for one compiled module binding. */
export function assertCompiledModuleBindingSemantics(input: {
  readonly binding: CompiledModuleBinding;
  readonly nodeId: string;
  readonly sourceId: string;
}): void {
  assertCompiledSourceBackingSemantics({
    backing: input.binding.backing,
    nodeId: input.nodeId,
    owner: input.binding.owner,
    sourceId: input.sourceId,
  });
}

/** Validates owner-specific invariants for any retained source backing. */
export function assertCompiledSourceBackingSemantics(input: {
  readonly backing: CompiledModuleBacking;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}): void {
  const { backing, owner } = input;

  if (owner.kind === "framework") {
    if (backing.kind !== "programmatic") {
      throw new Error(
        `Compiled node "${input.nodeId}" has framework-owned filesystem backing for "${input.sourceId}".`,
      );
    }
    if (backing.registryId !== owner.feature) {
      throw new Error(
        `Compiled node "${input.nodeId}" binds framework feature "${owner.feature}" to programmatic registry "${backing.registryId}" for "${input.sourceId}".`,
      );
    }
    return;
  }

  if (owner.kind === "application") {
    if (
      backing.kind === "programmatic" &&
      (backing.registryId === FRAMEWORK_AGENT_SOURCE_ID ||
        backing.registryId === FRAMEWORK_ROOT_AGENT_SOURCE_ID)
    ) {
      throw new Error(
        `Compiled node "${input.nodeId}" records reserved framework registry "${backing.registryId}" as application-owned for "${input.sourceId}".`,
      );
    }
    if (backing.kind === "filesystem" && backing.extensionScope !== undefined) {
      throw new Error(
        `Compiled node "${input.nodeId}" has application-owned filesystem backing with extension scope for "${input.sourceId}".`,
      );
    }
    return;
  }

  if (backing.kind !== "filesystem") {
    throw new Error(
      `Compiled node "${input.nodeId}" has extension-owned programmatic backing for "${input.sourceId}".`,
    );
  }

  const scope = backing.extensionScope;
  if (scope === undefined) {
    throw new Error(
      `Compiled node "${input.nodeId}" has an extension-owned filesystem binding for "${input.sourceId}" without an extension scope.`,
    );
  }
  if (scope.namespace.trim() === "" || scope.sourceRoot.trim() === "") {
    throw new Error(
      `Compiled node "${input.nodeId}" has an invalid extension scope for "${input.sourceId}".`,
    );
  }
  const expectedNamespace = packageStateNamespace(owner.packageName);
  if (scope.namespace !== expectedNamespace) {
    throw new Error(
      `Compiled node "${input.nodeId}" binds extension source "${input.sourceId}" to scope namespace "${scope.namespace}" instead of package namespace "${expectedNamespace}".`,
    );
  }
  if (!isPathInside(scope.sourceRoot, backing.sourcePath)) {
    throw new Error(
      `Compiled node "${input.nodeId}" binds extension source "${input.sourceId}" outside its extension scope root "${scope.sourceRoot}".`,
    );
  }
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
