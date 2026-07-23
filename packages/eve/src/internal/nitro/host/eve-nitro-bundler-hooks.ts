import { join } from "node:path";

import type { Nitro } from "nitro/types";

import { resolveWorkflowModulePath } from "#internal/application/package.js";
import { addNitroRoutingImportSpecifierPlugin } from "#internal/nitro/host/nitro-routing-import-specifier-plugin.js";
import type { EveNitroContribution } from "#internal/nitro/host/eve-nitro-contribution.js";
import {
  collectNitroStepTransformTargets,
  createRelativeTransformFilename,
  isWorkflowBundlePath,
  normalizeNitroModulePath,
  normalizeStepTransformComparisonPath,
  resolveNitroImportPath,
  resolveNitroModuleComparisonPath,
} from "#internal/nitro/host/nitro-module-paths.js";
import { transformDynamicToolExecute } from "#internal/workflow-bundle/dynamic-tool-transform.js";
import { applyWorkflowTransform } from "#internal/workflow-bundle/workflow-builders.js";

// Pre-built Workflow bundles preserve bare runtime specifiers, so Nitro must
// resolve them to eve's vendored Workflow copy rather than the host dependency graph.
const WORKFLOW_ALIAS_SPECIFIERS = [
  "workflow",
  "workflow/api",
  "workflow/errors",
  "workflow/internal/builtins",
  "workflow/internal/private",
  "workflow/runtime",
] as const;
const WORKFLOW_TRANSFORM_PATCHED = Symbol("eve.workflow-transform-patched");
type NitroExternalOption = NonNullable<NonNullable<Nitro["options"]["rollupConfig"]>["external"]>;

interface NitroStepTransformTargetCache {
  clear(): void;
  get(): Promise<Set<string>>;
}

function createNitroStepTransformTargetCache(
  nitro: Nitro,
  stepEntrypointPath: string,
): NitroStepTransformTargetCache {
  let cached: Set<string> | undefined;
  return {
    clear() {
      cached = undefined;
    },
    async get() {
      cached ??= await collectNitroStepTransformTargets(stepEntrypointPath, nitro.options.rootDir);
      return cached;
    },
  };
}

function resolveWorkflowAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const specifier of WORKFLOW_ALIAS_SPECIFIERS) {
    aliases[specifier] = resolveWorkflowModulePath(specifier);
  }
  return aliases;
}

export async function addNitroStepNoExternals(
  nitro: Nitro,
  stepEntrypointPath: string,
): Promise<void> {
  if (nitro.options.noExternals === true) {
    return;
  }

  let stepTransformTargets: Set<string>;

  try {
    stepTransformTargets = await collectNitroStepTransformTargets(
      stepEntrypointPath,
      nitro.options.rootDir,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
  const existingNoExternals = Array.isArray(nitro.options.noExternals)
    ? [...nitro.options.noExternals]
    : [];

  nitro.options.noExternals = [...new Set([...existingNoExternals, ...stepTransformTargets])];
}

function addWorkflowModuleSideEffectsPlugin(nitro: Nitro, workflowBuildDir: string): void {
  const workflowBundleDirectories = [
    workflowBuildDir,
    join(nitro.options.buildDir, "workflow"),
  ].map((directoryPath) => resolveNitroModuleComparisonPath(nitro.options.rootDir, directoryPath));

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      name: "eve:workflow-module-side-effects",
      resolveId(source: string, importer: string | undefined) {
        const resolvedSource =
          resolveNitroImportPath(nitro.options.rootDir, source, importer) ??
          resolveNitroModuleComparisonPath(nitro.options.rootDir, source);

        if (
          !workflowBundleDirectories.some((workflowBundleDirectory) =>
            isWorkflowBundlePath(resolvedSource, workflowBundleDirectory),
          )
        ) {
          return null;
        }

        return {
          id: resolvedSource,
          moduleSideEffects: "no-treeshake" as const,
        };
      },
    });
  });
}

function addNitroStepModuleSideEffectsPlugin(
  nitro: Nitro,
  cache: NitroStepTransformTargetCache,
): void {
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      name: "eve:workflow-step-module-side-effects",
      async resolveId(source: string, importer?: string) {
        const resolvedSource = resolveNitroImportPath(nitro.options.rootDir, source, importer);

        if (resolvedSource === null) {
          return null;
        }

        const stepTransformTargets = await cache.get();
        if (!stepTransformTargets.has(normalizeStepTransformComparisonPath(resolvedSource))) {
          return null;
        }

        return {
          id: resolvedSource,
          moduleSideEffects: "no-treeshake" as const,
        };
      },
    });
  });
}

function addNitroStepTransformPlugin(nitro: Nitro, cache: NitroStepTransformTargetCache): void {
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      async transform(code: string, id: string) {
        const stepTransformTargets = await cache.get();
        const resolvedId = resolveNitroModuleComparisonPath(nitro.options.rootDir, id);

        if (!stepTransformTargets.has(normalizeStepTransformComparisonPath(resolvedId))) {
          return null;
        }

        const result = await applyWorkflowTransform(
          createRelativeTransformFilename(nitro.options.rootDir, resolvedId),
          code,
          "step",
          resolvedId,
          nitro.options.rootDir,
        );

        return {
          code: result.code,
          map: null,
        };
      },
      name: "eve:workflow-step-transform",
    });
  });
}

function addDynamicToolTransformPlugin(nitro: Nitro): void {
  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      async transform(code: string, id: string) {
        if (!id.includes("/tools/")) return null;
        const result = await transformDynamicToolExecute(id, code);
        if (result === null) return null;
        return { code: result.code, map: null };
      },
      name: "eve:dynamic-tool-transform",
    });
  });
}

function addInstrumentationModuleSideEffectsPlugin(
  nitro: Nitro,
  instrumentationModulePath: string,
): void {
  const normalizedInstrumentationModulePath = normalizeNitroModulePath(instrumentationModulePath);

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    config.plugins.unshift({
      name: "eve:instrumentation-module-side-effects",
      resolveId(source: string) {
        if (normalizeNitroModulePath(source) !== normalizedInstrumentationModulePath) {
          return null;
        }

        return {
          id: source,
          moduleSideEffects: "no-treeshake" as const,
        };
      },
    });
  });
}

// Workflow's global transform must not process eve's generated bundles a second
// time because their directives and registrations have already been compiled.
function patchWorkflowTransformExcludePath(nitro: Nitro, workflowBuildDir: string): void {
  const normalizedWorkflowBuildDir = normalizeNitroModulePath(workflowBuildDir);

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    if (!Array.isArray(config.plugins)) {
      return;
    }

    for (const plugin of config.plugins) {
      if (plugin === null || plugin === undefined || typeof plugin !== "object") {
        continue;
      }

      const workflowTransformPlugin = plugin as {
        [WORKFLOW_TRANSFORM_PATCHED]?: true;
        name?: string;
        transform?: (this: unknown, code: string, id: string, ...rest: unknown[]) => unknown;
      };
      if (workflowTransformPlugin.name !== "workflow:transform") {
        continue;
      }
      if (workflowTransformPlugin[WORKFLOW_TRANSFORM_PATCHED] === true) {
        continue;
      }
      if (typeof workflowTransformPlugin.transform !== "function") {
        continue;
      }

      const originalTransform = workflowTransformPlugin.transform;
      workflowTransformPlugin.transform = function (
        this: unknown,
        code: string,
        id: string,
        ...rest: unknown[]
      ): unknown {
        if (isWorkflowBundlePath(id, normalizedWorkflowBuildDir)) {
          return null;
        }

        return originalTransform.call(this, code, id, ...rest);
      };
      workflowTransformPlugin[WORKFLOW_TRANSFORM_PATCHED] = true;
    }
  });
}

export function configureEveNitroBundlerHooks(
  nitro: Nitro,
  contribution: EveNitroContribution,
): void {
  addNitroRoutingImportSpecifierPlugin(nitro);
  if (contribution.workflowRoutes) {
    const workflowAliases = resolveWorkflowAliases();
    for (const [specifier, resolvedPath] of Object.entries(workflowAliases)) {
      nitro.options.alias[specifier] = resolvedPath;
    }
    addWorkflowModuleSideEffectsPlugin(nitro, contribution.preparedHost.workflowBuildDir);
    patchWorkflowTransformExcludePath(nitro, contribution.preparedHost.workflowBuildDir);
  }

  addDynamicToolTransformPlugin(nitro);

  if (contribution.preparedHost.compiledArtifacts.instrumentationSourcePath !== undefined) {
    addInstrumentationModuleSideEffectsPlugin(
      nitro,
      contribution.preparedHost.compiledArtifacts.instrumentationSourcePath,
    );
  }
}

export function configureEveNitroStepHooks(
  nitro: Nitro,
  stepEntrypointPath: string,
): Array<() => void> {
  const cache = createNitroStepTransformTargetCache(nitro, stepEntrypointPath);
  nitro.hooks.hook("build:before", cache.clear);
  addNitroStepModuleSideEffectsPlugin(nitro, cache);
  addNitroStepTransformPlugin(nitro, cache);
  return [cache.clear];
}

function matchesExternalOption(
  external: NitroExternalOption | undefined,
  id: string,
  importer: string | undefined,
  isResolved: boolean,
) {
  if (typeof external === "function") {
    return external(id, importer, isResolved);
  }
  if (external === undefined) {
    return undefined;
  }

  const entries = Array.isArray(external) ? external : [external];
  return entries.some((entry) => (typeof entry === "string" ? entry === id : entry.test(id)));
}

export function externalizeDevelopmentWorkflowBundle(
  nitro: Nitro,
  contribution: EveNitroContribution<"development">,
): void {
  const externalWorkflowModules = new Set([
    normalizeNitroModulePath(join(contribution.preparedHost.workflowBuildDir, "workflows.mjs")),
  ]);

  nitro.hooks.hook("rollup:before", (_nitro, config) => {
    const existingExternal = config.external;
    config.external = (id: string, importer: string | undefined, isResolved: boolean) => {
      if (externalWorkflowModules.has(normalizeNitroModulePath(id))) {
        return true;
      }
      return matchesExternalOption(existingExternal, id, importer, isResolved);
    };
  });
}
