import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { resolveInstalledPackageInfo, resolvePackageRoot } from "#internal/application/package.js";
import {
  FRAMEWORK_AGENT_SOURCE_ID,
  FRAMEWORK_ROOT_AGENT_SOURCE_ID,
} from "#framework-sources/constants.js";

export const EVE_RUNTIME_SOURCE_REVISION_TOKEN = "__EVE_RUNTIME_SOURCE_REVISION__";
export const eveRuntimeSourceRevisionStamp: { readonly value: string } = {
  value: EVE_RUNTIME_SOURCE_REVISION_TOKEN,
};

let cachedRuntimeSourceRevision: string | undefined;

interface RuntimeSourceRevisionEntry {
  readonly content: string | Uint8Array;
  readonly path: string;
}

/** Hashes logical runtime source paths and contents without physical-root identity. */
export function createEveRuntimeSourceRevision(
  entries: readonly RuntimeSourceRevisionEntry[],
): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path).update("\0").update(entry.content).update("\0");
  }
  return hash.digest("hex");
}

/** Resolves the content revision stamped into builds or hashes a source checkout. */
export function resolveEveRuntimeSourceRevision(
  options: { readonly fresh?: boolean } = {},
): string {
  const embeddedRevision = eveRuntimeSourceRevisionStamp.value;
  if (!embeddedRevision.startsWith("__")) {
    return embeddedRevision;
  }
  if (options.fresh !== true && cachedRuntimeSourceRevision !== undefined) {
    return cachedRuntimeSourceRevision;
  }
  const sourceRoot = join(resolvePackageRoot(), "src");
  const revision = createEveRuntimeSourceRevision(readRuntimeSourceEntries(sourceRoot));
  if (options.fresh !== true) {
    cachedRuntimeSourceRevision = revision;
  }
  return revision;
}

/** Revision carried by every framework programmatic backing. */
export function resolveFrameworkAgentSourceRevision(
  options: { readonly fresh?: boolean } = {},
): string {
  const { name, version } = resolveInstalledPackageInfo();
  return `${name}@${version}:${resolveEveRuntimeSourceRevision(options)}`;
}

/** Reads the single framework revision selected into a compiled manifest. */
export function readCompiledFrameworkSourceRevision(
  manifest: CompiledAgentManifest,
): string | undefined {
  const revisions = new Set<string>();
  for (const resources of [manifest, ...manifest.subagents.map((subagent) => subagent.agent)]) {
    for (const binding of Object.values(resources.bindings)) {
      if (
        binding.backing.kind === "programmatic" &&
        (binding.backing.registryId === FRAMEWORK_AGENT_SOURCE_ID ||
          binding.backing.registryId === FRAMEWORK_ROOT_AGENT_SOURCE_ID)
      ) {
        revisions.add(binding.backing.revision);
      }
    }
  }
  if (revisions.size > 1) {
    throw new Error("Compiled framework programmatic bindings disagree on their source revision.");
  }
  return revisions.values().next().value;
}

function readRuntimeSourceEntries(sourceRoot: string): RuntimeSourceRevisionEntry[] {
  const entries: RuntimeSourceRevisionEntry[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        entries.push({
          content: readFileSync(path),
          path: relative(sourceRoot, path).split(sep).join("/"),
        });
      }
    }
  };
  visit(sourceRoot);
  return entries;
}
