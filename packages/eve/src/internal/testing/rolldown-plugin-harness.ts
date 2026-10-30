import { dirname, isAbsolute, resolve } from "node:path";

import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";

const ENTRY = "\0eve-test-entry";

/** A module id as the filesystem identifies it: drive-qualified and case-insensitive on Windows. */
function fileKey(id: string): string {
  if (!isAbsolute(id)) return id;
  const path = resolve(id).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Bundles an entry through `plugins` with real Rolldown, so hook filters, hook
 * order, and tree-shaking behave as in a host build. The entry imports
 * `imports` for their side effects only and re-exports everything from
 * `reexports`. Modules no plugin provides load from `files` (empty when
 * absent), relative imports resolve against their importer, and any other
 * specifier stays external as `unresolved:<specifier>`. With `sideEffectFree`,
 * modules no plugin resolves are side-effect free, as Nitro's virtual modules
 * and many packages are, so only a plugin can keep their top-level code.
 */
export async function bundleThroughPlugins(input: {
  readonly plugins: readonly unknown[];
  readonly imports?: readonly string[];
  readonly reexports?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly sideEffectFree?: boolean;
}): Promise<string> {
  const files = new Map(
    Object.entries(input.files ?? {}).map(([id, code]) => [fileKey(id), code] as const),
  );
  const harness = {
    name: "eve-test-harness",
    resolveId(source: string, importer: string | undefined) {
      if (source === ENTRY) return source;
      const id = isAbsolute(source)
        ? source
        : source.startsWith(".") && importer !== undefined
          ? resolve(dirname(importer), source)
          : undefined;
      if (id === undefined) return { external: true, id: `unresolved:${source}` };
      return input.sideEffectFree === true ? { id, moduleSideEffects: false } : id;
    },
    load(id: string) {
      if (id === ENTRY) {
        return [
          ...(input.imports ?? []).map((specifier) => `import ${JSON.stringify(specifier)};`),
          ...(input.reexports ?? []).map(
            (specifier) => `export * from ${JSON.stringify(specifier)};`,
          ),
        ].join("\n");
      }
      return files.get(fileKey(id)) ?? "";
    },
  };
  const chunk = await buildSingleRolldownChunk("plugin harness bundle", {
    input: ENTRY,
    output: { comments: false, format: "esm" },
    platform: "node",
    plugins: [...input.plugins, harness],
  });
  return chunk.code;
}
