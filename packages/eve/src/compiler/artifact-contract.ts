/**
 * The compiled-artifact contract the runtime reads: kinds, versions and shapes, with no imports
 * from the compiler's build side, so loading compiled artifacts doesn't load the compiler.
 */
import type { DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";

/**
 * Stable compile metadata artifact kind emitted by the compiler.
 */
export const COMPILE_METADATA_KIND = "eve-compile-metadata";

/**
 * Current compile metadata schema version.
 */
export const COMPILE_METADATA_VERSION = 6;

/**
 * One artifact digest recorded in compile metadata.
 */
interface CompileArtifactDigest {
  path: string;
  sha256: string;
}

/**
 * Minimal compiler metadata artifact with versioning and hashes.
 */
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
