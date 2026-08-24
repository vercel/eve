import { existsSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createCompileMetadata,
  publishCompileMetadataCommitMarker,
  resolveCompilerArtifactPaths,
} from "#compiler/artifacts.js";
import { compileMetadataSchema } from "#protocol/compile-metadata.js";

export async function copyDevelopmentDiscoveryArtifacts(input: {
  readonly discoveryDirectoryPath: string | undefined;
  readonly runtimeAppRoot: string;
}): Promise<boolean> {
  if (input.discoveryDirectoryPath === undefined || !existsSync(input.discoveryDirectoryPath)) {
    return false;
  }
  for (const fileName of ["agent-discovery-manifest.json", "diagnostics.json"]) {
    if (!existsSync(join(input.discoveryDirectoryPath, fileName))) {
      throw new Error(
        `Cannot stage a development runtime generation without discovery artifact "${fileName}".`,
      );
    }
  }

  await cp(input.discoveryDirectoryPath, join(input.runtimeAppRoot, ".eve", "discovery"), {
    recursive: true,
  });
  return true;
}

export async function rewriteSnapshotCompileMetadata(runtimeAppRoot: string): Promise<void> {
  const paths = resolveCompilerArtifactPaths(runtimeAppRoot);
  const [
    compiledManifestJson,
    diagnosticsArtifactJson,
    discoveryManifestJson,
    moduleMapSource,
    previousMetadataJson,
  ] = await Promise.all([
    readFile(paths.compiledManifestPath, "utf8"),
    readFile(paths.diagnosticsPath, "utf8"),
    readFile(paths.discoveryManifestPath, "utf8"),
    readFile(paths.moduleMapPath, "utf8"),
    readFile(paths.compileMetadataPath, "utf8"),
  ]);
  const diagnostics = JSON.parse(diagnosticsArtifactJson) as {
    summary: { errors: number; warnings: number };
  };
  const previousMetadata = compileMetadataSchema.parse(JSON.parse(previousMetadataJson));
  const moduleMapIdentity = previousMetadata.compile.moduleMap.identitySha256;
  const metadata = createCompileMetadata({
    appRoot: runtimeAppRoot,
    compiledManifestJson,
    diagnosticsArtifactJson,
    diagnosticsSummary: diagnostics.summary,
    discoveryManifestJson,
    moduleMapIdentity,
    moduleMapSource,
    paths,
  });
  await publishCompileMetadataCommitMarker({
    contents: `${JSON.stringify(metadata, null, 2)}\n`,
    path: paths.compileMetadataPath,
  });
}
