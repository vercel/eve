import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { readDevelopmentGenerationMetadata } from "#internal/nitro/dev-runtime-generation-metadata.js";

import {
  resolvePackageCompiledFilePath,
  resolvePackageRoot,
  resolvePackageSourceDirectoryPath,
} from "#internal/application/package.js";

let frameworkFingerprint: Promise<string> | undefined;

/** Includes local framework edits, not just the version used in step identities. */
export function getDevelopmentFrameworkFingerprint(): Promise<string> {
  return (frameworkFingerprint ??= fingerprintFramework());
}

async function fingerprintFramework(): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(join(resolvePackageRoot(), "package.json")));
  for (const root of [
    resolvePackageSourceDirectoryPath("src"),
    resolvePackageCompiledFilePath("src/compiled/@workflow"),
  ]) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|d)\.[cm]?[jt]sx?$/.test(path))
      .sort();
    for (const path of files) {
      hash.update(relative(root, path));
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export type DevelopmentGenerationAvailability =
  | { readonly kind: "ready"; readonly runtimeAppRoot: string }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "incompatible"; readonly reason: string };

/** Compares fingerprints only when selecting retained generations for startup recovery. */
export async function readDevelopmentGenerationAvailability(
  appRoot: string,
  generationId: string,
  recoveryGenerationId?: string,
): Promise<DevelopmentGenerationAvailability> {
  const retained = await readDevelopmentGenerationMetadata(appRoot, generationId);
  if (retained.kind === "missing") {
    return { kind: "missing", reason: "Development runtime snapshot is no longer available" };
  }
  const active =
    recoveryGenerationId === undefined || generationId === recoveryGenerationId
      ? retained
      : await readDevelopmentGenerationMetadata(appRoot, recoveryGenerationId);
  if (retained.kind === "invalid" || active.kind === "invalid") {
    return {
      kind: "incompatible",
      reason:
        "Development generation metadata is invalid. Restore the affected snapshot from a backup or start a new session.",
    };
  }
  const { metadata } = retained;
  if (
    active.kind !== "ready" ||
    (recoveryGenerationId !== undefined &&
      (metadata.frameworkFingerprint !== (await getDevelopmentFrameworkFingerprint()) ||
        metadata.workflowSourceFingerprint !== active.metadata.workflowSourceFingerprint))
  ) {
    return {
      kind: "incompatible",
      reason:
        "Development runtime is incompatible with the retained workflow. Restore the original eve build and workflow sources to resume it, or start a new session.",
    };
  }
  return { kind: "ready", runtimeAppRoot: metadata.runtimeAppRoot };
}
