import { posix } from "node:path";

import { getSupportedModuleBaseName, normalizeLogicalPath } from "#discover/filesystem.js";

export type ProgrammaticModuleNamespace = Readonly<Record<string, unknown>>;

export interface ProgrammaticAgentModule {
  readonly exportName?: string;
  readonly loadNamespace: () => Promise<ProgrammaticModuleNamespace> | ProgrammaticModuleNamespace;
  readonly logicalPath: string;
  /** Optional module identity when source-wide revisions are intentionally broader. */
  readonly semanticRevision?: string;
}

export interface ProgrammaticAgentSource {
  readonly id: string;
  readonly modules: readonly ProgrammaticAgentModule[];
  /** Immutable identity of the package or generated source revision. */
  readonly revision: string;
}

export function defineProgrammaticAgentSource(
  input: ProgrammaticAgentSource,
): ProgrammaticAgentSource {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(input.id)) {
    throw new Error(
      `Programmatic agent source id "${input.id}" must start with a letter and contain only letters, digits, dots, underscores, or dashes.`,
    );
  }
  if (input.revision.length === 0) {
    throw new Error(`Programmatic agent source "${input.id}" must declare a non-empty revision.`);
  }

  const modules = input.modules.map((module) => {
    if (Object.hasOwn(module, "namespace")) {
      throw new Error(
        `Programmatic module "${module.logicalPath}" must expose a lazy loadNamespace() function, not an eager namespace value.`,
      );
    }
    if (typeof module.loadNamespace !== "function") {
      throw new Error(
        `Programmatic module "${module.logicalPath}" must expose a loadNamespace() function.`,
      );
    }
    if (
      module.semanticRevision !== undefined &&
      (typeof module.semanticRevision !== "string" || module.semanticRevision.length === 0)
    ) {
      throw new Error(
        `Programmatic module "${module.logicalPath}" must declare a non-empty semantic revision.`,
      );
    }
    const logicalPath = assertProgrammaticModuleLogicalPath(module.logicalPath);
    const compiledModule: {
      exportName?: string;
      loadNamespace: ProgrammaticAgentModule["loadNamespace"];
      logicalPath: string;
      semanticRevision?: string;
    } = {
      loadNamespace: module.loadNamespace,
      logicalPath,
    };
    if (module.exportName !== undefined) compiledModule.exportName = module.exportName;
    if (module.semanticRevision !== undefined) {
      compiledModule.semanticRevision = module.semanticRevision;
    }
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

  return Object.freeze({ id: input.id, modules: Object.freeze(modules), revision: input.revision });
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
    return (
      moduleName === "agent" ||
      moduleName === "instrumentation" ||
      moduleName === "instructions" ||
      moduleName === "sandbox"
    );
  }

  const [root] = segments;
  if (root === "channels" || root === "hooks") return segments.length >= 2;
  if (root === "connections") {
    return segments.length === 2 || (segments.length === 3 && moduleName === "connection");
  }
  if (root === "sandbox") return segments.length === 2 && moduleName === "sandbox";
  if (root === "instrumentation") return segments.length === 2;
  return (
    (root === "instructions" || root === "schedules" || root === "skills" || root === "tools") &&
    segments.length === 2
  );
}
