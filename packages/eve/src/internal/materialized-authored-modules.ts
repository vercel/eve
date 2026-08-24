import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, posix, relative, sep } from "node:path";

import { z } from "#compiled/zod/index.js";
import { publishCompileMetadataCommitMarker } from "#compiler/artifacts.js";
import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { bundleAuthoredModuleMapForGeneration } from "#internal/authored-module-loader.js";
import { serializeCompiledManifestForFingerprint } from "#internal/compiled-manifest-fingerprint.js";
import { compileMetadataSchema, type CompileMetadata } from "#protocol/compile-metadata.js";
import type { GenerationModuleMapDescriptorProjection } from "#internal/generation-module-map-projection.js";

const MATERIALIZED_MODULES_DIRECTORY = "authored-modules";
const MATERIALIZED_MODULES_INDEX = "authored-modules.json";

export interface MaterializedAuthoredModuleIndex {
  readonly fingerprint: string;
  readonly moduleMap: string;
  readonly version: 4;
}

export interface ValidatedMaterializedAuthoredModuleIndex extends MaterializedAuthoredModuleIndex {
  /** Exact authenticated descriptor bytes read while validating the committed index. */
  readonly moduleMapCode: string;
}

const materializedAuthoredModuleIndexSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    moduleMap: z.string().min(1),
    version: z.literal(4),
  })
  .strict();

export interface PreparedMaterializedAuthoredModules {
  readonly moduleMapCode: string;
}

/** Bundles authenticated compiler loaders with the relocated generation projection. */
export async function prepareMaterializedAuthoredModules(input: {
  readonly descriptorProjection?: GenerationModuleMapDescriptorProjection;
  readonly expectedIdentity: string;
  readonly manifest: CompiledAgentManifest;
  readonly moduleMapPath: string;
  readonly moduleMapSource: string;
}): Promise<PreparedMaterializedAuthoredModules> {
  const moduleMapCode = await bundleAuthoredModuleMapForGeneration({
    ...input,
    externalDependencyMode: "preserve-specifier",
    externalDependencyPlan: input.manifest.externalDependencyPlan,
  });
  return { moduleMapCode };
}

export async function writeMaterializedAuthoredModules(input: {
  readonly prepared: PreparedMaterializedAuthoredModules;
  readonly runtimeAppRoot: string;
}): Promise<MaterializedAuthoredModuleIndex> {
  const compileRoot = join(input.runtimeAppRoot, ".eve", "compile");
  const manifest = await readCompiledManifest(join(compileRoot, "compiled-agent-manifest.json"));
  const modulesRoot = join(compileRoot, MATERIALIZED_MODULES_DIRECTORY);
  const fingerprint = createHash("sha256");

  await mkdir(modulesRoot, { recursive: true });
  fingerprint
    .update("manifest\0")
    .update(
      serializeCompiledManifestForFingerprint({
        manifest,
        runtimeAppRoot: input.runtimeAppRoot,
      }),
    )
    .update("\0");
  const moduleMapFileName = createMaterializedModuleFileName(
    ROOT_COMPILED_AGENT_NODE_ID,
    "module-map",
    input.prepared.moduleMapCode,
  );
  const moduleMapPath = posix.join(MATERIALIZED_MODULES_DIRECTORY, moduleMapFileName);

  await writeFile(join(modulesRoot, moduleMapFileName), input.prepared.moduleMapCode);
  fingerprint.update("module-map\0").update(input.prepared.moduleMapCode).update("\0");

  await hashDirectoryIfPresent({
    fingerprint,
    path: join(compileRoot, "workspace-resources"),
    root: join(compileRoot, "workspace-resources"),
  });
  const index: {
    fingerprint: string;
    moduleMap: string;
    version: 4;
  } = {
    fingerprint: fingerprint.digest("hex"),
    moduleMap: moduleMapPath,
    version: 4,
  };
  const indexSource = `${JSON.stringify(index)}\n`;
  const indexPath = join(compileRoot, MATERIALIZED_MODULES_INDEX);
  const temporaryIndexPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryIndexPath, indexSource);
    await rename(temporaryIndexPath, indexPath);
  } finally {
    await rm(temporaryIndexPath, { force: true });
  }
  await commitMaterializedAuthoredModuleIndex({
    compileRoot,
    index,
    indexSource,
  });
  return index;
}

export async function readMaterializedAuthoredModuleIndex(input: {
  readonly metadata: CompileMetadata;
  readonly runtimeAppRoot: string;
}): Promise<ValidatedMaterializedAuthoredModuleIndex | undefined> {
  const committed = input.metadata.compile.materializedAuthoredModules;
  if (committed === undefined) {
    return undefined;
  }
  if (committed.path !== `.eve/compile/${MATERIALIZED_MODULES_INDEX}`) {
    throw new Error(`Invalid materialized authored module metadata path "${committed.path}".`);
  }
  const compileRoot = join(input.runtimeAppRoot, ".eve", "compile");
  const indexPath = join(compileRoot, MATERIALIZED_MODULES_INDEX);
  const indexSource = await readFile(indexPath, "utf8");
  assertDigest("materialized authored module index", committed.sha256, indexSource);

  const parsed = materializedAuthoredModuleIndexSchema.safeParse(JSON.parse(indexSource));
  if (!parsed.success) {
    throw new Error(`Invalid materialized authored module index at "${indexPath}".`);
  }
  if (parsed.data.fingerprint !== committed.fingerprintSha256) {
    throw new Error(
      `Materialized authored module fingerprint mismatch: expected "${committed.fingerprintSha256}", received "${parsed.data.fingerprint}".`,
    );
  }

  const manifest = await readCompiledManifest(join(compileRoot, "compiled-agent-manifest.json"));
  const moduleMapCode = await readValidatedMaterializedModule({
    compileRoot,
    modulePath: parsed.data.moduleMap,
    sourceId: "module-map",
  });
  const fingerprint = createHash("sha256");
  fingerprint
    .update("manifest\0")
    .update(
      serializeCompiledManifestForFingerprint({
        manifest,
        runtimeAppRoot: input.runtimeAppRoot,
      }),
    )
    .update("\0")
    .update("module-map\0")
    .update(moduleMapCode)
    .update("\0");

  await hashDirectoryIfPresent({
    fingerprint,
    path: join(compileRoot, "workspace-resources"),
    root: join(compileRoot, "workspace-resources"),
  });
  const actualFingerprint = fingerprint.digest("hex");
  if (actualFingerprint !== parsed.data.fingerprint) {
    throw new Error(
      `Materialized authored module content fingerprint mismatch: expected "${parsed.data.fingerprint}", received "${actualFingerprint}".`,
    );
  }

  return { ...parsed.data, moduleMapCode };
}

async function commitMaterializedAuthoredModuleIndex(input: {
  readonly compileRoot: string;
  readonly index: MaterializedAuthoredModuleIndex;
  readonly indexSource: string;
}): Promise<void> {
  const metadataPath = join(input.compileRoot, "compile-metadata.json");
  const previous = compileMetadataSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")));
  const metadata: CompileMetadata = {
    ...previous,
    compile: {
      ...previous.compile,
      materializedAuthoredModules: {
        fingerprintSha256: input.index.fingerprint,
        path: `.eve/compile/${MATERIALIZED_MODULES_INDEX}`,
        sha256: createHash("sha256").update(input.indexSource).digest("hex"),
      },
    },
  };
  await publishCompileMetadataCommitMarker({
    contents: `${JSON.stringify(metadata, null, 2)}\n`,
    path: metadataPath,
  });
}

async function readValidatedMaterializedModule(input: {
  readonly compileRoot: string;
  readonly modulePath: string;
  readonly sourceId: string;
}): Promise<string> {
  assertMaterializedModulePath(input.modulePath);
  const path = join(input.compileRoot, input.modulePath);
  const code = await readFile(path, "utf8");
  const expectedFileName = createMaterializedModuleFileName(
    ROOT_COMPILED_AGENT_NODE_ID,
    input.sourceId,
    code,
  );
  if (basename(path) !== expectedFileName) {
    throw new Error(
      `Materialized authored module "${input.modulePath}" does not match its content-addressed file name "${expectedFileName}".`,
    );
  }
  return code;
}

function assertMaterializedModulePath(path: string): void {
  if (
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    posix.dirname(path) !== MATERIALIZED_MODULES_DIRECTORY ||
    !/^[a-f0-9]{64}\.mjs$/.test(posix.basename(path))
  ) {
    throw new Error(
      `Materialized authored module path "${path}" must name a content-addressed file directly under "${MATERIALIZED_MODULES_DIRECTORY}".`,
    );
  }
}

function assertDigest(label: string, expected: string, contents: string): void {
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== expected) {
    throw new Error(`${label} digest mismatch: expected "${expected}", received "${actual}".`);
  }
}

async function readCompiledManifest(path: string): Promise<CompiledAgentManifest> {
  return parseCompiledAgentManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function createMaterializedModuleFileName(nodeId: string, sourceId: string, code: string): string {
  return `${createHash("sha256")
    .update(nodeId)
    .update("\0")
    .update(sourceId)
    .update("\0")
    .update(code)
    .digest("hex")}.mjs`;
}

async function hashDirectoryIfPresent(input: {
  readonly fingerprint: ReturnType<typeof createHash>;
  readonly path: string;
  readonly root: string;
}): Promise<void> {
  if (!existsSync(input.path)) {
    return;
  }

  const stats = await lstat(input.path);
  const relativePath = toPortablePath(relative(input.root, input.path));

  if (stats.isSymbolicLink()) {
    input.fingerprint
      .update(relativePath)
      .update("\0link\0")
      .update(await readlink(input.path))
      .update("\0");
    return;
  }

  if (stats.isDirectory()) {
    for (const entry of (await readdir(input.path)).sort()) {
      await hashDirectoryIfPresent({
        ...input,
        path: join(input.path, entry),
      });
    }
    return;
  }

  if (stats.isFile()) {
    input.fingerprint
      .update(relativePath)
      .update("\0file\0")
      .update(await readFile(input.path))
      .update("\0");
  }
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}
