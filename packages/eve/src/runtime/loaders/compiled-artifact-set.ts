import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { compiledAgentManifestSchema } from "#compiler/manifest.js";
import { type CompiledModuleMap } from "#compiler/module-map.js";
import { assertSerializedCompiledAgentManifestSemantics } from "#compiler/compiled-manifest-validation.js";
import { compileMetadataSchema, type CompileMetadata } from "#protocol/compile-metadata.js";
import {
  assertCompiledArtifactSetSemantics,
  validateCompiledArtifactMetadataSemantics,
} from "#protocol/compiled-artifact-set.js";
import {
  assertCompilerDiagnosticsArtifactSemantics,
  compilerDiagnosticsArtifactSchema,
  type CompilerDiagnosticsArtifact,
} from "#protocol/compiler-diagnostics-artifact.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { formatValidationError } from "#runtime/validation.js";
import { verifyCompiledExternalDependencyPlanFiles } from "#compiler/external-dependency-plan.js";
import { serializeArtifactJson } from "#protocol/artifact-json.js";

/** One validated runtime snapshot loaded before authored definitions hydrate. */
export interface LoadedCompiledArtifactSet {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly moduleMap: CompiledModuleMap;
}

/** The complete validated inert envelope, before any module namespace hydrates. */
export type LoadedCompiledArtifactEnvelope = Omit<LoadedCompiledArtifactSet, "moduleMap">;

/** Error raised when the complete compiled snapshot is incomplete or inconsistent. */
export class LoadCompiledArtifactSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadCompiledArtifactSetError";
  }
}

export interface DiskCompiledArtifactSnapshot {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly moduleMapPath: string;
  readonly moduleMapSource: string;
}

interface DiskCompiledArtifactReader {
  readonly readFile: (path: string) => Promise<string>;
}

const DISK_SNAPSHOT_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 250, 250, 250, 250] as const;

/** Loads and validates metadata, diagnostics, manifest, and module map as one snapshot. */
export async function loadCompiledArtifactSet(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<LoadedCompiledArtifactSet> {
  if (input.compiledArtifactsSource.kind === "bundled") {
    return await loadBundledCompiledArtifactSet();
  }

  const snapshot = await readStableDiskCompiledArtifactSnapshot(
    input.compiledArtifactsSource.appRoot,
  );

  try {
    await verifyCompiledExternalDependencyPlanFiles(snapshot.manifest.externalDependencyPlan);
    const moduleMap = await loadDiskCompiledModuleMap({
      compiledArtifactsSource: input.compiledArtifactsSource,
      snapshot,
    });
    assertCompiledArtifactSetSemantics({ ...snapshot, moduleMap });
    return {
      diagnostics: snapshot.diagnostics,
      manifest: snapshot.manifest,
      metadata: snapshot.metadata,
      moduleMap,
    };
  } catch (error) {
    throw new LoadCompiledArtifactSetError(formatError(error));
  }
}

/** Loads all inert artifacts through the same stable boundary used before hydration. */
export async function loadCompiledArtifactEnvelope(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<LoadedCompiledArtifactEnvelope> {
  if (input.compiledArtifactsSource.kind === "bundled") {
    const { diagnostics, manifest, metadata } = await loadBundledCompiledArtifactSet();
    return { diagnostics, manifest, metadata };
  }

  const { diagnostics, manifest, metadata } = await readStableDiskCompiledArtifactSnapshot(
    input.compiledArtifactsSource.appRoot,
  );
  return { diagnostics, manifest, metadata };
}

async function loadBundledCompiledArtifactSet(): Promise<LoadedCompiledArtifactSet> {
  const bundled = readBundledCompiledArtifacts();
  if (bundled === null) {
    throw new LoadCompiledArtifactSetError("Bundled compiled artifacts are unavailable.");
  }
  try {
    await assertBundledDigests(bundled);
    assertCompiledArtifactSetSemantics(bundled);
  } catch (error) {
    throw new LoadCompiledArtifactSetError(formatError(error));
  }
  return bundled;
}

export async function readStableDiskCompiledArtifactSnapshot(
  appRoot: string,
  reader?: DiskCompiledArtifactReader,
): Promise<DiskCompiledArtifactSnapshot> {
  const artifactReader = reader ?? {
    async readFile(path: string) {
      const { readFile } = await import("node:fs/promises");
      return await readFile(path, "utf8");
    },
  };
  let lastError: unknown;
  for (let attempt = 0; attempt <= DISK_SNAPSHOT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await readDiskCompiledArtifactSnapshotOnce(appRoot, artifactReader);
    } catch (error) {
      lastError = error;
      const retryDelay = DISK_SNAPSHOT_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  throw new LoadCompiledArtifactSetError(formatError(lastError));
}

async function readDiskCompiledArtifactSnapshotOnce(
  appRoot: string,
  reader: DiskCompiledArtifactReader,
): Promise<DiskCompiledArtifactSnapshot> {
  const paths = resolveRuntimeCompilerArtifactPaths(appRoot);
  const metadataSourceBefore = await reader.readFile(paths.compileMetadataPath);
  const metadata = parseMetadata(metadataSourceBefore, paths.compileMetadataPath);
  const [compiledManifestSource, diagnosticsSource, discoveryManifestSource, moduleMapSource] =
    await Promise.all([
      reader.readFile(paths.compiledManifestPath),
      reader.readFile(paths.diagnosticsPath),
      reader.readFile(paths.discoveryManifestPath),
      reader.readFile(paths.moduleMapPath),
    ]);
  const metadataSourceAfter = await reader.readFile(paths.compileMetadataPath);
  if (metadataSourceBefore !== metadataSourceAfter) {
    throw new Error("Compile metadata changed while its artifact payloads were being read.");
  }

  const manifest = parseManifest(compiledManifestSource, paths.compiledManifestPath);
  const diagnostics = parseDiagnostics(diagnosticsSource, paths.diagnosticsPath);
  assertCompilerDiagnosticsArtifactSemantics({ artifact: diagnostics, manifest });
  const metadataIssues = validateCompiledArtifactMetadataSemantics({ diagnostics, metadata });
  if (metadataIssues.length > 0) {
    throw new Error(`Invalid compile metadata:\n- ${metadataIssues.join("\n- ")}`);
  }

  const [compiledManifestHash, diagnosticsHash, discoveryManifestHash, moduleMapHash] =
    await Promise.all([
      sha256(compiledManifestSource),
      sha256(diagnosticsSource),
      sha256(discoveryManifestSource),
      sha256(moduleMapSource),
    ]);
  assertDigest("compiled manifest", metadata.compile.manifest.sha256, compiledManifestHash);
  assertDigest("compiler diagnostics", metadata.discovery.diagnostics.sha256, diagnosticsHash);
  assertDigest("discovery manifest", metadata.discovery.manifest.sha256, discoveryManifestHash);
  assertDigest("compiled module map", metadata.compile.moduleMap.sha256, moduleMapHash);
  const sourceGraphHash = await sha256(
    `${discoveryManifestHash}:${compiledManifestHash}:${diagnosticsHash}:${moduleMapHash}:${metadata.compile.moduleMap.identitySha256}`,
  );
  assertDigest("source graph", metadata.discovery.sourceGraphHash, sourceGraphHash);

  return {
    diagnostics,
    manifest,
    metadata,
    moduleMapPath: paths.moduleMapPath,
    moduleMapSource,
  };
}

async function loadDiskCompiledModuleMap(input: {
  readonly compiledArtifactsSource: Extract<RuntimeCompiledArtifactsSource, { kind: "disk" }>;
  readonly snapshot: DiskCompiledArtifactSnapshot;
}): Promise<CompiledModuleMap> {
  const expectedIdentity = input.snapshot.metadata.compile.moduleMap.identitySha256;
  const loader =
    input.compiledArtifactsSource.moduleMapLoaderPath === undefined
      ? await import("#internal/authored-module-map-loader.js")
      : ((await import(
          (
            await import("node:url")
          ).pathToFileURL(input.compiledArtifactsSource.moduleMapLoaderPath).href
        )) as typeof import("#internal/authored-module-map-loader.js"));
  const mode =
    input.compiledArtifactsSource.moduleMapLoaderKind ??
    (input.snapshot.metadata.compile.materializedAuthoredModules === undefined
      ? "authored-source"
      : "materialized-generation");

  return await loader.loadCompiledModuleMapFromValidatedManifest({
    diagnostics: input.snapshot.diagnostics,
    expectedIdentity,
    manifest: input.snapshot.manifest,
    metadata: input.snapshot.metadata,
    mode,
    moduleMapPath: input.snapshot.moduleMapPath,
    moduleMapSource: input.snapshot.moduleMapSource,
    runtimeAppRoot: input.compiledArtifactsSource.appRoot,
  });
}

async function assertBundledDigests(input: LoadedCompiledArtifactSet): Promise<void> {
  const [manifestHash, diagnosticsHash] = await Promise.all([
    sha256(serializeArtifactJson(input.manifest)),
    sha256(serializeArtifactJson(input.diagnostics)),
  ]);
  assertDigest("compiled manifest", input.metadata.compile.manifest.sha256, manifestHash);
  assertDigest(
    "compiler diagnostics",
    input.metadata.discovery.diagnostics.sha256,
    diagnosticsHash,
  );
  const sourceGraphHash = await sha256(
    `${input.metadata.discovery.manifest.sha256}:${manifestHash}:${diagnosticsHash}:${input.metadata.compile.moduleMap.sha256}:${input.metadata.compile.moduleMap.identitySha256}`,
  );
  assertDigest("source graph", input.metadata.discovery.sourceGraphHash, sourceGraphHash);
}

function parseMetadata(source: string, path: string): CompileMetadata {
  const parsed = compileMetadataSchema.safeParse(JSON.parse(source) as unknown);
  if (!parsed.success) {
    throw new Error(
      `Expected "${path}" to contain valid eve compile metadata. ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function parseManifest(source: string, path: string): CompiledAgentManifest {
  const parsed = compiledAgentManifestSchema.safeParse(JSON.parse(source) as unknown);
  if (!parsed.success) {
    throw new Error(
      `Expected "${path}" to contain a valid compiled eve agent manifest. ${formatValidationError(parsed.error)}`,
    );
  }
  assertSerializedCompiledAgentManifestSemantics(parsed.data);
  return parsed.data;
}

function parseDiagnostics(source: string, path: string): CompilerDiagnosticsArtifact {
  const parsed = compilerDiagnosticsArtifactSchema.safeParse(JSON.parse(source) as unknown);
  if (!parsed.success) {
    throw new Error(
      `Expected "${path}" to contain valid eve compiler diagnostics. ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function assertDigest(label: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(
      `Compile metadata ${label} digest mismatch: expected "${expected}", received "${actual}".`,
    );
  }
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown compiled artifact-set failure.";
}
