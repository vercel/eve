import { pathToFileURL } from "node:url";

import { type CompiledModuleMap, compiledModuleMapSchema } from "#compiler/module-map.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { formatValidationError } from "#runtime/validation.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";

const BUNDLED_MODULE_MAP_SOURCE = "bundled compiled module map";

/**
 * Input for loading the compiled module map from disk or the bundled runtime
 * alias.
 */
interface LoadCompiledModuleMapInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}

/**
 * Error raised when the compiled module map cannot be loaded or validated.
 */
export class LoadCompiledModuleMapError extends Error {
  readonly moduleMapPath?: string;

  constructor(message: string, moduleMapPath?: string) {
    super(message);
    this.name = "LoadCompiledModuleMapError";

    if (moduleMapPath !== undefined) {
      this.moduleMapPath = moduleMapPath;
    }
  }
}

/**
 * Loads and validates the compiler-owned module map.
 */
export async function loadCompiledModuleMap(
  input: LoadCompiledModuleMapInput,
): Promise<CompiledModuleMap> {
  const moduleMapPath =
    input.compiledArtifactsSource.kind === "disk"
      ? resolveRuntimeCompilerArtifactPaths(input.compiledArtifactsSource.appRoot).moduleMapPath
      : undefined;

  if (moduleMapPath !== undefined) {
    const moduleMapImportSpecifier = createFileImportSpecifier(moduleMapPath);

    try {
      const moduleNamespace = (await import(moduleMapImportSpecifier)) as {
        default?: unknown;
        moduleMap?: unknown;
      };

      return parseCompiledModuleMap(
        moduleNamespace.moduleMap ?? moduleNamespace.default,
        moduleMapPath,
      );
    } catch (error) {
      throw new LoadCompiledModuleMapError(formatLoadErrorMessage(error), moduleMapPath);
    }
  }

  const bundledArtifacts = readBundledCompiledArtifacts();

  if (bundledArtifacts !== null) {
    return parseCompiledModuleMap(bundledArtifacts.moduleMap, BUNDLED_MODULE_MAP_SOURCE);
  }

  throw new LoadCompiledModuleMapError(
    "Compiled module map is unavailable without an app root or bundled compiled artifacts.",
    BUNDLED_MODULE_MAP_SOURCE,
  );
}

/**
 * Loads the compiled module map the way the runtime does. When the source is a
 * disk build that ships an authored-source module-map loader (dev and build
 * flows), authored modules are hydrated through it so tsconfig path aliases and
 * NodeNext `.js` import specifiers resolve to their `.ts` sources. Otherwise it
 * falls back to the bundled/compiled module map.
 *
 * Every runtime consumer that re-reads authored config (the compiled-agent
 * cache and source-backed model resolution) must go through this single entry
 * point so they resolve modules identically; importing the compiled
 * `module-map.mjs` directly skips the authored-source loader and fails to
 * resolve `.js` specifiers between authored source files in dev.
 */
export async function loadRuntimeCompiledModuleMap(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<CompiledModuleMap> {
  if (
    compiledArtifactsSource.kind === "disk" &&
    compiledArtifactsSource.moduleMapLoaderPath !== undefined
  ) {
    const loader = (await import(
      pathToFileURL(compiledArtifactsSource.moduleMapLoaderPath).href
    )) as typeof import("#internal/authored-module-map-loader.js");

    return await loader.loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource,
    });
  }

  return await loadCompiledModuleMap({ compiledArtifactsSource });
}

function parseCompiledModuleMap(value: unknown, moduleMapPath: string): CompiledModuleMap {
  const parsed = compiledModuleMapSchema.safeParse(value);

  if (!parsed.success) {
    throw new LoadCompiledModuleMapError(
      `Expected "${moduleMapPath}" to export a valid compiled eve module map. ${formatValidationError(parsed.error)}`,
      moduleMapPath,
    );
  }

  return parsed.data;
}

function formatLoadErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown module-map load failure.";
}

function createFileImportSpecifier(moduleMapPath: string): string {
  const normalizedPath = moduleMapPath.replaceAll("\\", "/");

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return `file:///${encodeURI(normalizedPath)}`;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${encodeURI(normalizedPath)}`;
  }

  return normalizedPath;
}
