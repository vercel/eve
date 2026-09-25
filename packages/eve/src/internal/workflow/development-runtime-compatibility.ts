import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

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

export async function readDevelopmentGenerationAvailability(
  appRoot: string,
  generationId: string,
  activeGenerationId: string,
): Promise<DevelopmentGenerationAvailability> {
  const metadata = await readMetadata(appRoot, generationId);
  if (metadata === undefined) {
    return { kind: "missing", reason: "Development runtime snapshot is no longer available" };
  }
  const active =
    generationId === activeGenerationId
      ? metadata
      : await readMetadata(appRoot, activeGenerationId);
  if (
    active === undefined ||
    metadata.frameworkFingerprint !== (await getDevelopmentFrameworkFingerprint()) ||
    metadata.workflowSourceFingerprint !== active?.workflowSourceFingerprint
  ) {
    return {
      kind: "incompatible",
      reason:
        "Development runtime is incompatible with the retained workflow. Restore the original eve build and workflow sources to resume it, or start a new session.",
    };
  }
  return { kind: "ready", runtimeAppRoot: metadata.runtimeAppRoot };
}

async function readMetadata(
  appRoot: string,
  generationId: string,
): Promise<
  | {
      runtimeAppRoot: string;
      frameworkFingerprint?: string;
      workflowSourceFingerprint?: string;
    }
  | undefined
> {
  if (
    !generationId ||
    generationId === "." ||
    generationId === ".." ||
    basename(generationId) !== generationId
  ) {
    throw new Error("Workflow run references an invalid development generation.");
  }
  let source: string;
  try {
    source = await readFile(
      join(appRoot, ".eve", "dev-runtime", "snapshots", generationId, "generation.json"),
      "utf8",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const metadata = JSON.parse(source);
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    typeof metadata.runtimeAppRoot !== "string"
  ) {
    throw new Error(`Development generation "${generationId}" has invalid metadata.`);
  }
  return metadata;
}
