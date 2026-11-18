import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { isAuthoredTestPath } from "#discover/filesystem.js";

const INSTRUMENTATION_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

const INSTRUMENTATION_DIRECTORY = "instrumentation";

export interface InstrumentationLayout {
  readonly kind: "directory";
  readonly modulePathsBySlot: Readonly<Record<string, string>>;
}

export function resolveInstrumentationLayout(input: {
  readonly agentRoot: string;
}): InstrumentationLayout {
  const removedFilePath = findRemovedInstrumentationFile(input.agentRoot);
  const directoryPath = join(input.agentRoot, INSTRUMENTATION_DIRECTORY);
  const hasDirectory = existsSync(directoryPath) && statSync(directoryPath).isDirectory();

  if (removedFilePath !== undefined) {
    throw new Error(
      `Found removed instrumentation file "${removedFilePath}". Move it into the "${INSTRUMENTATION_DIRECTORY}/" directory as one file per provider. See the instrumentation migration guide.`,
    );
  }

  if (!hasDirectory) {
    return { kind: "directory", modulePathsBySlot: {} };
  }

  return {
    kind: "directory",
    modulePathsBySlot: collectInstrumentationProviderModules(directoryPath),
  };
}

function collectInstrumentationProviderModules(
  directoryPath: string,
): Readonly<Record<string, string>> {
  const modulePathsBySlot = new Map<string, string>();

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (!entry.isFile() || isAuthoredTestPath(entry.name)) continue;

    const extension = INSTRUMENTATION_EXTENSIONS.find((candidate) =>
      entry.name.endsWith(candidate),
    );
    if (extension === undefined) continue;

    const slot = entry.name.slice(0, -extension.length);
    if (slot === "") continue;

    const existing = modulePathsBySlot.get(slot);
    if (existing !== undefined) {
      throw new Error(
        `Two files declare the "${slot}" instrumentation provider in "${directoryPath}". Keep one of them.`,
      );
    }

    modulePathsBySlot.set(slot, join(directoryPath, entry.name));
  }

  return Object.fromEntries(
    [...modulePathsBySlot].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function findRemovedInstrumentationFile(agentRoot: string): string | undefined {
  for (const extension of INSTRUMENTATION_EXTENSIONS) {
    const candidate = join(agentRoot, `${INSTRUMENTATION_DIRECTORY}${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
