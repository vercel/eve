import type { DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";

export const COMPILE_METADATA_KIND = "eve-compile-metadata";

export const COMPILE_METADATA_VERSION = 6;

interface CompileArtifactDigest {
  path: string;
  sha256: string;
}

export interface CompileMetadata {
  compile: {
    manifest: CompileArtifactDigest;
    moduleMap: CompileArtifactDigest;
  };
  discovery: {
    diagnostics: CompileArtifactDigest;
    manifest: CompileArtifactDigest;
    sourceGraphHash: string;
    summary: DiscoverDiagnosticsSummary;
  };
  generator: {
    name: string;
    version: string;
  };
  kind: typeof COMPILE_METADATA_KIND;
  status: "failed" | "ready";
  version: typeof COMPILE_METADATA_VERSION;
}
