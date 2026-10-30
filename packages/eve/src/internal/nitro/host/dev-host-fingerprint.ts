import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { readDevelopmentEnvironmentHostValues } from "#cli/dev/environment.js";
import { createHostSpec } from "#internal/nitro/host/host-spec.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

/**
 * Hashes everything that shapes a development host build: the host spec minus
 * its locations, plus the inputs the host bundles or bakes in from disk.
 */
export async function computeDevelopmentHostFingerprint(
  host: PreparedDevelopmentApplicationHost,
): Promise<string> {
  const { appRoot, workspace } = host;
  const {
    authored,
    locations: _locations,
    extensionMounts,
    extensionOverridePaths,
    ...spec
  } = createHostSpec(
    host,
    { kind: "development" },
    { buildDir: workspace.nitroBuildDir, outputDir: workspace.nitroOutputDir },
  );
  // Equivalent hosts in different app roots or package stores share a
  // fingerprint. Some paths are canonical, so the app root may appear as either.
  const roots = [appRoot, realpathSync(appRoot)];
  const portable = (path: string) =>
    roots
      .map((root) => relative(root, path))
      .find((candidate) => !candidate.startsWith("..") && !isAbsolute(candidate)) ??
    relative(appRoot, path);
  const payload = {
    environment: readDevelopmentEnvironmentHostValues(appRoot),
    instrumentation: await readInstrumentationSource(host),
    spec: {
      ...spec,
      authored: {
        packageRoot: portable(authored.packageRoot),
        tsconfig: authored.tsconfig === false ? false : portable(authored.tsconfig),
      },
      extensionMounts: extensionMounts.map(
        ({ mountSourcePath, programmaticImport, sourceRoot, ...mount }) => ({
          ...mount,
          mountSourcePath: portable(mountSourcePath),
          // Its config reaches the extension through the runtime module map.
          ...(programmaticImport && {
            programmaticImport: {
              entryPath: portable(programmaticImport.entryPath),
              specifier: programmaticImport.specifier,
            },
          }),
          sourceRoot: portable(sourceRoot),
        }),
      ),
      extensionOverridePaths: [...extensionOverridePaths].map(([sourcePath, mountId]) => [
        portable(sourcePath),
        mountId,
      ]),
    },
    // Authored workflow bodies and step registrations are bundled into the
    // host, so their sources are structural, not runtime, state.
    workflowSources: host.generation.workflowSourceFingerprint ?? null,
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function readInstrumentationSource(host: PreparedDevelopmentApplicationHost): Promise<{
  readonly kind: "directory";
  readonly modules: readonly { readonly slot: string; readonly source: string }[];
} | null> {
  const paths = host.compiledArtifacts.instrumentationSourcePaths;
  const layout = host.compiledArtifacts.instrumentationLayout;
  if (paths === undefined || layout === undefined) {
    return null;
  }
  const sources = await Promise.all(paths.map(async (path) => await readFile(path, "utf8")));
  return {
    kind: layout.kind,
    modules: sources.map((source, index) => ({
      slot: layout.slots[index]!,
      source,
    })),
  };
}
