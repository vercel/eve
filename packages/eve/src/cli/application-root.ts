import { dirname, resolve } from "node:path";

import { isEveProject } from "#setup/scaffold/index.js";

export interface ResolveCliApplicationRootDependencies {
  readonly isEveProject: (path: string) => Promise<boolean>;
}

const defaultDependencies: ResolveCliApplicationRootDependencies = {
  isEveProject,
};

/** Resolves the nearest enclosing eve application for a project-scoped command. */
export async function resolveCliApplicationRoot(
  cwd: string = process.cwd(),
  dependencies: ResolveCliApplicationRootDependencies = defaultDependencies,
): Promise<string> {
  let candidate = resolve(cwd);
  while (true) {
    if (await dependencies.isEveProject(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error("No eve application found in this directory or its ancestors.");
    }
    candidate = parent;
  }
}
