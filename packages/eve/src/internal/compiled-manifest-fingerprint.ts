import { isAbsolute, relative, sep } from "node:path";

import type { CompiledAgentManifest } from "#compiler/manifest.js";

const RUNTIME_ROOT_TOKEN = "$runtime";

export function serializeCompiledManifestForFingerprint(input: {
  readonly manifest: CompiledAgentManifest;
  readonly runtimeAppRoot: string;
}): string {
  return JSON.stringify(normalizeValue(input.manifest, input.runtimeAppRoot));
}

function normalizeValue(value: unknown, runtimeAppRoot: string): unknown {
  if (typeof value === "string") {
    return normalizeRuntimePath(value, runtimeAppRoot);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, runtimeAppRoot));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeValue(entry, runtimeAppRoot)]),
  );
}

function normalizeRuntimePath(value: string, runtimeAppRoot: string): string {
  if (!isAbsolute(value)) {
    return value;
  }

  const relativePath = relative(runtimeAppRoot, value);
  if (relativePath === "") {
    return RUNTIME_ROOT_TOKEN;
  }
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return value;
  }
  return `${RUNTIME_ROOT_TOKEN}/${relativePath.split(sep).join("/")}`;
}
