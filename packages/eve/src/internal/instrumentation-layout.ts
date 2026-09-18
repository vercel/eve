import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const INSTRUMENTATION_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

const INSTRUMENTATION_DIRECTORY = "instrumentation";

/** Instrumentation providers keyed by their path-derived slot name. */
export interface InstrumentationLayout {
  readonly kind: "directory";
  readonly modulePathsBySlot: Readonly<Record<string, string>>;
}

/**
 * Resolves the instrumentation layout for one agent root.
 *
 * An empty directory layout still installs eve's built-in destinations.
 * The removed single-file layout is rejected with a migration-oriented error.
 */
export function resolveInstrumentationLayout(input: {
  readonly agentRoot: string;
}): InstrumentationLayout {
  const filePath = resolveInstrumentationFile(input.agentRoot);
  const directoryPath = join(input.agentRoot, INSTRUMENTATION_DIRECTORY);
  const hasDirectory = existsSync(directoryPath) && statSync(directoryPath).isDirectory();

  if (filePath !== undefined) {
    throw new Error(
      `Found removed instrumentation file "${filePath}". Move it into the "${INSTRUMENTATION_DIRECTORY}/" directory as one file per provider. See the instrumentation migration guide.`,
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

/**
 * Maps each `instrumentation/<slot>.<ext>` file to its absolute path.
 *
 * Slots are sorted so the registration order a provider sees does not depend on
 * how the filesystem happens to enumerate the directory.
 */
function collectInstrumentationProviderModules(
  directoryPath: string,
): Readonly<Record<string, string>> {
  const modulePathsBySlot = new Map<string, string>();

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;

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

/**
 * Resolves the removed single `agent/instrumentation` module.
 */
function resolveInstrumentationFile(agentRoot: string): string | undefined {
  for (const extension of INSTRUMENTATION_EXTENSIONS) {
    const candidate = join(agentRoot, `${INSTRUMENTATION_DIRECTORY}${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
