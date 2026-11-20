import { dirname, isAbsolute, resolve } from "node:path";

import type { RolldownPluginOption } from "rolldown";

import { buildSingleRolldownChunk } from "#internal/bundler/rolldown.js";

const ENTRY = "\0eve-test-entry";

function fileKey(id: string): string {
  if (!isAbsolute(id)) return id;
  const path = resolve(id).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export async function bundleThroughPlugins(input: {
  readonly plugins: readonly RolldownPluginOption[];
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
