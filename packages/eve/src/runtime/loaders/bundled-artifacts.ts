import { assertSerializedCompiledAgentManifestSemantics } from "#compiler/compiled-manifest-validation.js";
import { compiledModuleBackingSchema } from "#compiler/module-binding.js";
import type { CompiledModuleBacking } from "#compiler/module-binding.js";
import { collectCompiledModuleScopes } from "#compiler/module-scope.js";
import { compiledAgentManifestSchema, type CompiledAgentManifest } from "#compiler/manifest.js";
import { compiledModuleMapSchema, type CompiledModuleMap } from "#compiler/module-map.js";
import {
  assertCompiledArtifactSetSemantics,
  validateCompiledArtifactMetadataSemantics,
} from "#protocol/compiled-artifact-set.js";
import { compileMetadataSchema, type CompileMetadata } from "#protocol/compile-metadata.js";
import {
  assertCompilerDiagnosticsArtifactSemantics,
  compilerDiagnosticsArtifactSchema,
  type CompilerDiagnosticsArtifact,
} from "#protocol/compiler-diagnostics-artifact.js";
import { formatValidationError } from "#runtime/validation.js";
import {
  identifyCompiledModuleMap,
  readCompiledModuleMapIdentity,
} from "#protocol/compiled-module-map-identity.js";
import { serializeArtifactJson } from "#protocol/artifact-json.js";
import {
  createRuntimeSession,
  getActiveRuntimeSession,
  withRuntimeSession,
} from "#runtime/sessions/runtime-session.js";

/**
 * Bundled compiled artifacts installed by Nitro when authored runtime state is
 * embedded directly into the server bundle.
 */
export interface BundledCompiledArtifacts {
  diagnostics: CompilerDiagnosticsArtifact;
  manifest: CompiledAgentManifest;
  metadata: CompileMetadata;
  moduleMap: CompiledModuleMap;
}

type BundledCompiledModuleMapLoader =
  | {
      readonly artifactIdentity: string;
      readonly backing: Extract<CompiledModuleBacking, { readonly kind: "filesystem" }>;
      readonly load: () => Promise<Record<string, unknown>>;
      readonly validate?: never;
    }
  | {
      readonly artifactIdentity: string;
      readonly backing: Extract<CompiledModuleBacking, { readonly kind: "programmatic" }>;
      readonly load: () => Promise<Record<string, unknown>>;
      readonly validate: () => Promise<void> | void;
    };

export interface BundledCompiledModuleMapDescriptor {
  readonly identity: string;
  readonly nodes: Readonly<
    Record<
      string,
      {
        readonly modules: Readonly<Record<string, BundledCompiledModuleMapLoader>>;
      }
    >
  >;
}

/**
 * Input for running code against one isolated bundled compiled-artifact
 * snapshot.
 */
export interface WithBundledCompiledArtifactsInput extends BundledCompiledArtifacts {
  readonly sessionId?: string;
}

/**
 * Installs one bundled compiled-artifact snapshot on the active runtime
 * session. In production this writes to the process-default session at
 * Nitro bootstrap time; inside a `withRuntimeSession` scope it targets the
 * scoped session so tests cannot leak installations across each other.
 */
export function installBundledCompiledArtifacts(input: BundledCompiledArtifacts): void {
  const diagnostics = compilerDiagnosticsArtifactSchema.safeParse(input.diagnostics);
  if (!diagnostics.success) {
    throw new Error(
      `Cannot install bundled compiled artifacts with invalid compiler diagnostics. ${formatValidationError(diagnostics.error)}`,
    );
  }
  const manifest = compiledAgentManifestSchema.safeParse(input.manifest);
  if (!manifest.success) {
    throw new Error(
      `Cannot install bundled compiled artifacts with an invalid compiled manifest. ${formatValidationError(manifest.error)}`,
    );
  }
  const metadata = compileMetadataSchema.safeParse(input.metadata);
  if (!metadata.success) {
    throw new Error(
      `Cannot install bundled compiled artifacts with invalid compile metadata. ${formatValidationError(metadata.error)}`,
    );
  }
  try {
    assertSerializedCompiledAgentManifestSemantics(manifest.data);
    assertCompilerDiagnosticsArtifactSemantics({
      artifact: diagnostics.data,
      manifest: manifest.data,
    });
    const metadataIssues = validateCompiledArtifactMetadataSemantics({
      diagnostics: diagnostics.data,
      metadata: metadata.data,
    });
    if (metadataIssues.length > 0) {
      throw new Error(`Invalid compile metadata:\n- ${metadataIssues.join("\n- ")}`);
    }
  } catch (error) {
    throw new Error(
      `Cannot install inconsistent bundled compiled artifacts. ${formatInstallError(error)}`,
    );
  }

  const moduleMap = compiledModuleMapSchema.safeParse(input.moduleMap);
  if (!moduleMap.success) {
    throw new Error(
      `Cannot install bundled compiled artifacts with an invalid compiled module map. ${formatValidationError(moduleMap.error)}`,
    );
  }
  const rawModuleMapIdentity = readCompiledModuleMapIdentity(input.moduleMap);
  const parsedModuleMap =
    rawModuleMapIdentity === undefined
      ? moduleMap.data
      : identifyCompiledModuleMap(moduleMap.data, rawModuleMapIdentity);

  try {
    assertCompiledArtifactSetSemantics({
      diagnostics: diagnostics.data,
      manifest: manifest.data,
      metadata: metadata.data,
      moduleMap: parsedModuleMap,
    });
  } catch (error) {
    throw new Error(
      `Cannot install inconsistent bundled compiled artifacts. ${formatInstallError(error)}`,
    );
  }

  getActiveRuntimeSession().compiledArtifacts = {
    diagnostics: diagnostics.data,
    manifest: manifest.data,
    metadata: metadata.data,
    moduleMap: parsedModuleMap,
  };
}

/**
 * Validates all inert bundle artifacts before invoking any namespace loader,
 * then hydrates and installs the exact descriptor that passed preflight.
 */
export async function installBundledCompiledArtifactsFromDescriptor(input: {
  readonly diagnostics: unknown;
  readonly manifest: unknown;
  readonly metadata: unknown;
  readonly moduleMapDescriptor: unknown;
}): Promise<void> {
  const envelope = await validateBundledCompiledArtifactEnvelope(input);
  await validateCompiledModuleMapDescriptorRegistries(envelope.moduleMapDescriptor);
  const moduleMap = await hydrateCompiledModuleMapDescriptor(envelope.moduleMapDescriptor);
  installBundledCompiledArtifacts({ ...envelope, moduleMap });
}

export async function validateBundledCompiledArtifactEnvelope(input: {
  readonly diagnostics: unknown;
  readonly manifest: unknown;
  readonly metadata: unknown;
  readonly moduleMapDescriptor: unknown;
}): Promise<{
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly moduleMapDescriptor: BundledCompiledModuleMapDescriptor;
}> {
  const diagnostics = compilerDiagnosticsArtifactSchema.safeParse(input.diagnostics);
  if (!diagnostics.success) {
    throw new Error(
      `Cannot install bundled compiled artifacts with invalid compiler diagnostics. ${formatValidationError(diagnostics.error)}`,
    );
  }
  const manifest = compiledAgentManifestSchema.safeParse(input.manifest);
  if (!manifest.success) {
    throw new Error(
      `Cannot install bundled compiled artifacts with an invalid compiled manifest. ${formatValidationError(manifest.error)}`,
    );
  }
  const metadata = compileMetadataSchema.safeParse(input.metadata);
  if (!metadata.success) {
    throw new Error(
      `Cannot install bundled compiled artifacts with invalid compile metadata. ${formatValidationError(metadata.error)}`,
    );
  }
  const descriptor = parseCompiledModuleMapDescriptor(input.moduleMapDescriptor);

  try {
    assertSerializedCompiledAgentManifestSemantics(manifest.data);
    assertCompilerDiagnosticsArtifactSemantics({
      artifact: diagnostics.data,
      manifest: manifest.data,
    });
    const metadataIssues = validateCompiledArtifactMetadataSemantics({
      diagnostics: diagnostics.data,
      metadata: metadata.data,
    });
    if (metadataIssues.length > 0) {
      throw new Error(`Invalid compile metadata:\n- ${metadataIssues.join("\n- ")}`);
    }
    assertCompiledModuleMapDescriptorSemantics({
      descriptor,
      diagnostics: diagnostics.data,
      manifest: manifest.data,
      metadata: metadata.data,
    });
    await assertBundledEnvelopeDigests({
      diagnostics: diagnostics.data,
      manifest: manifest.data,
      metadata: metadata.data,
    });
  } catch (error) {
    throw new Error(
      `Cannot install inconsistent bundled compiled artifacts. ${formatInstallError(error)}`,
    );
  }

  return {
    diagnostics: diagnostics.data,
    manifest: manifest.data,
    metadata: metadata.data,
    moduleMapDescriptor: descriptor,
  };
}

export function parseCompiledModuleMapDescriptor(
  value: unknown,
): BundledCompiledModuleMapDescriptor {
  if (!isRecord(value) || typeof value.identity !== "string" || !isRecord(value.nodes)) {
    throw new Error(
      "Cannot install bundled compiled artifacts with an invalid module-map descriptor.",
    );
  }
  const nodes: Record<
    string,
    {
      modules: Record<
        string,
        BundledCompiledModuleMapDescriptor["nodes"][string]["modules"][string]
      >;
    }
  > = {};
  for (const [nodeId, scope] of Object.entries(value.nodes)) {
    if (!isRecord(scope) || !isRecord(scope.modules)) {
      throw new Error(
        "Cannot install bundled compiled artifacts with an invalid module-map descriptor.",
      );
    }
    const modules: (typeof nodes)[string]["modules"] = {};
    for (const [sourceId, loader] of Object.entries(scope.modules)) {
      const backing = isRecord(loader)
        ? compiledModuleBackingSchema.safeParse(loader.backing)
        : undefined;
      if (
        !isRecord(loader) ||
        typeof loader.artifactIdentity !== "string" ||
        backing === undefined ||
        !backing.success ||
        typeof loader.load !== "function" ||
        (loader.validate !== undefined && typeof loader.validate !== "function") ||
        Object.keys(loader).some(
          (key) =>
            key !== "artifactIdentity" && key !== "backing" && key !== "load" && key !== "validate",
        )
      ) {
        throw new Error(
          "Cannot install bundled compiled artifacts with an invalid module-map descriptor loader.",
        );
      }
      if (backing.data.kind === "programmatic" && typeof loader.validate !== "function") {
        throw new Error(
          `Programmatic module-map descriptor loader "${nodeId}:${sourceId}" must define a registry validator.`,
        );
      }
      if (backing.data.kind === "filesystem" && loader.validate !== undefined) {
        throw new Error(
          `Filesystem module-map descriptor loader "${nodeId}:${sourceId}" cannot define a registry validator.`,
        );
      }
      const load = loader.load as () => Promise<Record<string, unknown>>;
      if (backing.data.kind === "programmatic") {
        const validate = loader.validate as () => Promise<void> | void;
        modules[sourceId] = {
          artifactIdentity: loader.artifactIdentity,
          backing: backing.data,
          load: async () => await load(),
          validate: () => validate(),
        };
      } else {
        modules[sourceId] = {
          artifactIdentity: loader.artifactIdentity,
          backing: backing.data,
          load: async () => await load(),
        };
      }
    }
    nodes[nodeId] = { modules };
  }
  return { identity: value.identity, nodes };
}

/** Validates an inert descriptor projection against its compiled envelope. */
export function assertCompiledModuleMapDescriptorSemantics(input: {
  readonly descriptor: BundledCompiledModuleMapDescriptor;
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
}): void {
  const inertModuleMap = identifyCompiledModuleMap(
    {
      nodes: Object.fromEntries(
        Object.entries(input.descriptor.nodes).map(([nodeId, scope]) => [
          nodeId,
          {
            modules: Object.fromEntries(
              Object.keys(scope.modules).map((sourceId) => [sourceId, {}]),
            ),
          },
        ]),
      ),
    },
    input.descriptor.identity,
  );
  assertCompiledArtifactSetSemantics({
    diagnostics: input.diagnostics,
    manifest: input.manifest,
    metadata: input.metadata,
    moduleMap: inertModuleMap,
  });
  assertCompiledModuleMapDescriptorBindings(input.manifest, input.descriptor);
}

/** Validates every selected programmatic registration before any namespace executes. */
export async function validateCompiledModuleMapDescriptorRegistries(
  descriptor: BundledCompiledModuleMapDescriptor,
): Promise<void> {
  const validations = Object.entries(descriptor.nodes).flatMap(([nodeId, scope]) =>
    Object.entries(scope.modules).flatMap(([sourceId, module]) => {
      if (module.backing.kind === "filesystem") {
        if (module.validate !== undefined) {
          throw new Error(
            `Filesystem module-map descriptor loader "${nodeId}:${sourceId}" cannot define a registry validator.`,
          );
        }
        return [];
      }
      if (typeof module.validate !== "function") {
        throw new Error(
          `Programmatic module-map descriptor loader "${nodeId}:${sourceId}" must define a registry validator.`,
        );
      }
      return [Promise.resolve().then(() => module.validate())];
    }),
  );
  const results = await Promise.allSettled(validations);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
}

function assertCompiledModuleMapDescriptorBindings(
  manifest: CompiledAgentManifest,
  descriptor: BundledCompiledModuleMapDescriptor,
): void {
  for (const scope of collectCompiledModuleScopes(manifest)) {
    for (const sourceId of new Set(scope.refs.map((ref) => ref.sourceId))) {
      const expected = scope.bindings[sourceId]?.backing;
      const actual = descriptor.nodes[scope.nodeId]?.modules[sourceId];
      if (expected === undefined || actual === undefined) {
        throw new Error(
          `Module-map descriptor is missing binding projection "${scope.nodeId}:${sourceId}".`,
        );
      }
      if (actual.artifactIdentity !== descriptor.identity) {
        throw new Error(
          `Module-map descriptor loader "${scope.nodeId}:${sourceId}" belongs to artifact "${actual.artifactIdentity}", not "${descriptor.identity}".`,
        );
      }
      if (JSON.stringify(actual.backing) !== JSON.stringify(expected)) {
        throw new Error(
          `Module-map descriptor binding mismatch for "${scope.nodeId}:${sourceId}".`,
        );
      }
    }
  }
}

/** Hydrates a descriptor only after its inert envelope and registries pass preflight. */
export async function hydrateCompiledModuleMapDescriptor(
  descriptor: BundledCompiledModuleMapDescriptor,
): Promise<CompiledModuleMap> {
  const nodes: CompiledModuleMap["nodes"] = {};
  for (const [nodeId, scope] of Object.entries(descriptor.nodes)) {
    const modules: Record<string, Record<string, unknown>> = {};
    for (const [sourceId, module] of Object.entries(scope.modules)) {
      modules[sourceId] = await module.load();
    }
    nodes[nodeId] = Object.freeze({ modules: Object.freeze(modules) });
  }
  return identifyCompiledModuleMap({ nodes: Object.freeze(nodes) }, descriptor.identity);
}

async function assertBundledEnvelopeDigests(input: {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
}): Promise<void> {
  const manifestHash = await sha256(serializeArtifactJson(input.manifest));
  const diagnosticsHash = await sha256(serializeArtifactJson(input.diagnostics));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runs `fn` with bundled compiled artifacts installed on a fresh scoped
 * runtime session, leaving the process-default runtime session untouched.
 */
export async function withBundledCompiledArtifacts<T>(
  input: WithBundledCompiledArtifactsInput,
  fn: () => Promise<T> | T,
): Promise<T> {
  const session = createRuntimeSession(input.sessionId ?? "bundled-compiled-artifacts");

  return await withRuntimeSession(session, async () => {
    installBundledCompiledArtifacts(input);
    return await fn();
  });
}

/**
 * Reads the bundled compiled-artifact snapshot for the active runtime
 * session, or `null` if none has been installed.
 */
export function readBundledCompiledArtifacts(): BundledCompiledArtifacts | null {
  return getActiveRuntimeSession().compiledArtifacts;
}

function formatInstallError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown bundled artifact failure.";
}
