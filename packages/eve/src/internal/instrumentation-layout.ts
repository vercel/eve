import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "#internal/logging.js";

const INSTRUMENTATION_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

const INSTRUMENTATION_DIRECTORY = "instrumentation";

const PROVIDERS_FLAG = "experimental.instrumentationProviders";
const log = createLogger("internal.instrumentation-layout");

/**
 * How instrumentation is authored for one agent.
 *
 * `file` is the single `agent/instrumentation.ts` default export. `directory`
 * contains one provider per file, keyed by the slot name the
 * file derives (`instrumentation/otel.ts` → `otel`). Which one an agent may use
 * is decided by `experimental.instrumentationProviders`, never by what happens
 * to be on disk.
 */
export type InstrumentationLayout =
  | { readonly kind: "file"; readonly modulePath: string }
  | { readonly kind: "directory"; readonly modulePathsBySlot: Readonly<Record<string, string>> };

/**
 * Resolves the instrumentation layout for one agent root.
 *
 * With providers on, an empty directory layout still installs eve's built-in
 * destinations. Throws when the layout on disk is not the one the flag selects:
 * the wrong layout would otherwise be skipped silently, and telemetry that
 * quietly does nothing is the failure this whole surface exists to prevent.
 */
export function resolveInstrumentationLayout(input: {
  readonly agentRoot: string;
  readonly providersEnabled: boolean;
}): InstrumentationLayout | undefined {
  const filePath = resolveInstrumentationFile(input.agentRoot);
  const directoryPath = join(input.agentRoot, INSTRUMENTATION_DIRECTORY);
  const hasDirectory = existsSync(directoryPath) && statSync(directoryPath).isDirectory();

  if (!input.providersEnabled) {
    if (hasDirectory) {
      log.warn("ignoring instrumentation provider directory because providers are off", {
        agentRoot: input.agentRoot,
        flag: PROVIDERS_FLAG,
      });
    }

    return filePath === undefined ? undefined : { kind: "file", modulePath: filePath };
  }

  if (filePath !== undefined) {
    throw new Error(
      `Found "${filePath}", but \`${PROVIDERS_FLAG}\` is on. Move it into the "${INSTRUMENTATION_DIRECTORY}/" directory as one file per provider.`,
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
 * Resolves the single `agent/instrumentation` module, ignoring any directory of
 * the same name.
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
