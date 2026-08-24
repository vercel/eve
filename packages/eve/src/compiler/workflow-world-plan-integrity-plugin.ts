import { realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCompiledWorkflowWorldPlanIntegrity,
  type CompiledHostModuleWorkflowWorldPlan,
  type CompiledWorkflowWorldPlan,
} from "#compiler/workflow-world-plan.js";
import { isWorkflowWorldPackageName } from "#internal/workflow/world-target.js";

const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

/** Guards a host bundle against its selected custom World changing mid-build. */
export function createWorkflowWorldPlanIntegrityPlugin(input: {
  readonly plan: CompiledWorkflowWorldPlan;
  readonly assertIntegrity?: () => Promise<void>;
}): Record<string, unknown> {
  const assertIntegrity =
    input.assertIntegrity ?? (() => assertCompiledWorkflowWorldPlanIntegrity(input.plan));

  return {
    name: "eve-workflow-world-plan-integrity",
    buildStart: assertIntegrity,
    buildEnd: assertIntegrity,
    resolveId(source: string, importer: string | undefined) {
      if (input.plan.kind === "native" || importer === undefined) return null;
      assertBoundWorkflowWorldImport(input.plan, source, importer);
      return null;
    },
  };
}

function assertBoundWorkflowWorldImport(
  plan: CompiledHostModuleWorkflowWorldPlan,
  source: string,
  importer: string,
): void {
  const packageName = packageNameOfImport(source);
  if (packageName === undefined) return;

  const importerPath = canonicalImportPathOf(importer);
  const owner = plan.backing.packages.find((selectedPackage) =>
    isPathInsideOrEqual(importerPath, selectedPackage.rootPath),
  );
  if (owner === undefined || packageName === owner.name) return;

  const dependencyId = owner.dependencies[packageName];
  if (dependencyId === undefined) {
    throw new Error(
      `Workflow world package ${JSON.stringify(owner.name)} imports undeclared package ${JSON.stringify(packageName)}. Declare it in the package manifest so eve can bind it during compilation.`,
    );
  }
  // A null edge is an unavailable optional dependency. Normal resolution must
  // see it as missing so guarded package fallbacks keep working.
}

function packageNameOfImport(source: string): string | undefined {
  if (
    NODE_BUILTIN_MODULES.has(source) ||
    source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("\\") ||
    source.startsWith("#") ||
    source.startsWith("\0") ||
    source.includes(":")
  ) {
    return undefined;
  }
  const segments = source.split("/");
  const packageName = source.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
  return isWorkflowWorldPackageName(packageName) ? packageName : undefined;
}

function canonicalImportPathOf(importer: string): string {
  const withoutSuffix = importer.split(/[?#]/u, 1)[0] ?? importer;
  const importerPath = withoutSuffix.startsWith("file:")
    ? fileURLToPath(withoutSuffix)
    : withoutSuffix;
  try {
    return realpathSync.native(importerPath);
  } catch {
    return importerPath;
  }
}

function isPathInsideOrEqual(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
