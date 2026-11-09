import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  BUILD_DEPLOYMENT_ID_PLACEHOLDER,
  computeBuildDeploymentId,
  replaceBuildDeploymentId,
  type BuildDeploymentFile,
} from "#internal/nitro/host/build-deployment-id.js";

async function optionalPeerIdentity(outputDirectory: string): Promise<string> {
  // otel-registration probes this peer with createRequire at runtime, outside Nitro tracing.
  const require = createRequire(join(outputDirectory, "server", "index.mjs"));
  let entryPath: string;
  try {
    entryPath = require.resolve("@opentelemetry/api");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      return "@opentelemetry/api@absent";
    }
    throw error;
  }
  for (let directory = dirname(entryPath); ; directory = dirname(directory)) {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (
        manifest !== null &&
        typeof manifest === "object" &&
        "name" in manifest &&
        manifest.name === "@opentelemetry/api" &&
        "version" in manifest &&
        typeof manifest.version === "string"
      ) {
        return `@opentelemetry/api@${manifest.version}`;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (dirname(directory) === directory) {
      throw new Error(
        "Cannot compute build deployment id: @opentelemetry/api has no package version.",
      );
    }
  }
}

/** The World plugin is always bundled into an eve server chunk, never a traced dependency. */
function mayContainPlaceholder(relativePath: string): boolean {
  return (
    relativePath.startsWith("server/") &&
    relativePath.endsWith(".mjs") &&
    !relativePath.split("/").includes("node_modules")
  );
}

/** Hashes the staged output, installs the id in the World plugin, and returns the id. */
export async function stageBuildDeploymentId(outputDirectory: string): Promise<string> {
  const relativePaths: string[] = [];
  async function walk(relativeDirectory: string, ancestors: ReadonlySet<string>): Promise<void> {
    const directory = join(outputDirectory, relativeDirectory);
    const canonicalDirectory = await realpath(directory);
    if (ancestors.has(canonicalDirectory)) {
      throw new Error(`Cannot hash build output: cyclic directory link at ${relativeDirectory}.`);
    }
    const nextAncestors = new Set([...ancestors, canonicalDirectory]);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const info = entry.isSymbolicLink() ? await stat(join(outputDirectory, relativePath)) : entry;
      if (info.isDirectory()) await walk(relativePath, nextAncestors);
      else if (info.isFile()) relativePaths.push(relativePath);
      else throw new Error(`Cannot hash build output: unsupported file type at ${relativePath}.`);
    }
  }
  await walk("", new Set());

  const placeholder = Buffer.from(BUILD_DEPLOYMENT_ID_PLACEHOLDER);
  const candidates: BuildDeploymentFile[] = [];
  const deploymentId = await computeBuildDeploymentId(
    relativePaths,
    async (relativePath) => {
      const bytes = await readFile(join(outputDirectory, relativePath));
      if (mayContainPlaceholder(relativePath) && bytes.includes(placeholder)) {
        candidates.push({ relativePath, bytes });
      }
      return bytes;
    },
    [
      `eve@${resolveInstalledPackageInfo().version}`,
      `node@${process.version}`,
      await optionalPeerIdentity(outputDirectory),
    ],
  );
  const replacement = replaceBuildDeploymentId(candidates, deploymentId);
  await writeFile(join(outputDirectory, replacement.relativePath), replacement.bytes);
  return deploymentId;
}
