import { posix } from "node:path";

import { getSupportedModuleBaseName, normalizeLogicalPath } from "#discover/filesystem.js";

export type ProgrammaticModuleNamespace = Readonly<Record<string, unknown>>;

export interface ProgrammaticAgentModule {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly namespace: ProgrammaticModuleNamespace;
}

export interface ProgrammaticAgentSource {
  readonly id: string;
  readonly modules: readonly ProgrammaticAgentModule[];
}

export function defineProgrammaticAgentSource(
  input: ProgrammaticAgentSource,
): ProgrammaticAgentSource {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(input.id)) {
    throw new Error(
      `Programmatic agent source id "${input.id}" must start with a letter and contain only letters, digits, dots, underscores, or dashes.`,
    );
  }

  const modules = input.modules.map((module) => {
    const logicalPath = assertProgrammaticModuleLogicalPath(module.logicalPath);
    const namespace = Object.freeze({ ...module.namespace });
    const compiledModule: {
      exportName?: string;
      logicalPath: string;
      namespace: ProgrammaticModuleNamespace;
    } = {
      logicalPath,
      namespace,
    };
    if (module.exportName !== undefined) compiledModule.exportName = module.exportName;
    return Object.freeze(compiledModule);
  });
  const paths = new Set<string>();
  for (const module of modules) {
    if (paths.has(module.logicalPath)) {
      throw new Error(
        `Programmatic agent source "${input.id}" declares "${module.logicalPath}" more than once.`,
      );
    }
    paths.add(module.logicalPath);
  }

  return Object.freeze({ id: input.id, modules: Object.freeze(modules) });
}

export function assertProgrammaticModuleLogicalPath(input: string): string {
  if (
    input.length === 0 ||
    input.includes("\\") ||
    input.startsWith("/") ||
    input.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      `Programmatic module path "${input}" must be a normalized relative POSIX path.`,
    );
  }

  const logicalPath = normalizeLogicalPath(input);
  if (posix.normalize(logicalPath) !== logicalPath) {
    throw new Error(
      `Programmatic module path "${input}" must be a normalized relative POSIX path.`,
    );
  }
  const segments = logicalPath.split("/");
  const moduleName = getSupportedModuleBaseName(segments.at(-1)!);
  if (moduleName === null || !isModuleBackedSlot(segments, moduleName)) {
    throw new Error(`Programmatic module path "${input}" does not select an eve module slot.`);
  }

  return logicalPath;
}

function isModuleBackedSlot(segments: readonly string[], moduleName: string): boolean {
  if (segments.length === 1) {
    return moduleName === "agent" || moduleName === "instructions" || moduleName === "sandbox";
  }

  const [root] = segments;
  if (root === "channels" || root === "hooks") return segments.length >= 2;
  if (root === "connections") {
    return segments.length === 2 || (segments.length === 3 && moduleName === "connection");
  }
  if (root === "sandbox") return segments.length === 2 && moduleName === "sandbox";
  return (
    (root === "instructions" || root === "schedules" || root === "skills" || root === "tools") &&
    segments.length === 2
  );
}
