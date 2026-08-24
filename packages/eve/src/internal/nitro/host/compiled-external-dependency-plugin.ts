import type { CompiledExternalDependencyPlan } from "#compiler/external-dependency-plan.js";
import {
  resolveCompiledExternalDependencyImport,
  verifyCompiledExternalDependencyPlanFiles,
} from "#compiler/external-dependency-plan.js";

interface BundlerPluginShape {
  readonly name: string;
  buildEnd(): Promise<void>;
  buildStart(): Promise<void>;
  resolveId(source: string): { external: true; id: string } | null;
}

/** Externalizes only packages selected by the compiler-owned dependency closure. */
export function createCompiledExternalDependencyPlugin(input: {
  readonly plan: CompiledExternalDependencyPlan;
  readonly tracedPaths: Record<string, string>;
}): BundlerPluginShape | null {
  const { plan } = input;
  if (plan.entries.length === 0) return null;

  return {
    name: "eve-compiled-external-dependency",
    async buildStart() {
      await verifyCompiledExternalDependencyPlanFiles(plan);
    },
    async buildEnd() {
      await verifyCompiledExternalDependencyPlanFiles(plan);
    },
    resolveId(source) {
      const resolution = resolveCompiledExternalDependencyImport(plan, source);
      if (resolution === undefined) return null;
      input.tracedPaths[source] = resolution.resolvedPath;
      return { external: true, id: source };
    },
  };
}
