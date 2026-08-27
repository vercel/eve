import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { COMPILED_AGENT_MANIFEST_KIND, ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { PreparedAuthoredRuntimeModules } from "#internal/authored-runtime-modules.js";
import { serializeCompiledManifestForFingerprint } from "#internal/compiled-manifest-fingerprint.js";

const MATERIALIZED_MODULES_DIRECTORY = "authored-modules";
const MATERIALIZED_MODULES_INDEX = "authored-modules.json";

/**
 * The materialized instrumentation modules, mirroring the layout they were
 * authored in. Paths are relative to `.eve/compile`.
 */
export type MaterializedInstrumentation =
  | { readonly kind: "file"; readonly modulePath: string }
  | { readonly kind: "directory"; readonly modulePathsBySlot: Readonly<Record<string, string>> };

export interface MaterializedAuthoredModuleIndex {
  readonly fingerprint: string;
  readonly instrumentation?: MaterializedInstrumentation;
  readonly moduleMap: string;
  readonly version: 3;
}

export async function writeMaterializedAuthoredModules(input: {
  readonly prepared: PreparedAuthoredRuntimeModules;
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
  const moduleMapPath = join(MATERIALIZED_MODULES_DIRECTORY, moduleMapFileName);

  await writeFile(join(modulesRoot, moduleMapFileName), input.prepared.moduleMapCode);
  fingerprint.update("module-map\0").update(input.prepared.moduleMapCode).update("\0");

  const materializeInstrumentationModule = async (
    sourceId: string,
    code: string,
  ): Promise<string> => {
    const fileName = createMaterializedModuleFileName(
      ROOT_COMPILED_AGENT_NODE_ID,
      `instrumentation:${sourceId}`,
      code,
    );

    await writeFile(join(modulesRoot, fileName), code);
    fingerprint.update(`instrumentation:${sourceId}\0`).update(code).update("\0");
    return join(MATERIALIZED_MODULES_DIRECTORY, fileName);
  };

  let instrumentation: MaterializedInstrumentation | undefined;

  if (input.prepared.instrumentation !== undefined) {
    const modulePathsBySlot: Record<string, string> = {};
    for (const [slot, code] of Object.entries(input.prepared.instrumentation.moduleCodeBySlot)) {
      modulePathsBySlot[slot] = await materializeInstrumentationModule(slot, code);
    }
    instrumentation = { kind: "directory", modulePathsBySlot };
  }

  await hashDirectoryIfPresent({
    fingerprint,
    path: join(compileRoot, "workspace-resources"),
    root: join(compileRoot, "workspace-resources"),
  });
  const index: {
    fingerprint: string;
    instrumentation?: MaterializedInstrumentation;
    moduleMap: string;
    version: 3;
  } = {
    fingerprint: fingerprint.digest("hex"),
    moduleMap: moduleMapPath,
    version: 3,
  };
  if (instrumentation !== undefined) {
    index.instrumentation = instrumentation;
  }
  await writeFile(join(compileRoot, MATERIALIZED_MODULES_INDEX), `${JSON.stringify(index)}\n`);
  return index;
}

export async function readMaterializedAuthoredModuleIndex(
  runtimeAppRoot: string,
): Promise<MaterializedAuthoredModuleIndex | undefined> {
  const indexPath = join(runtimeAppRoot, ".eve", "compile", MATERIALIZED_MODULES_INDEX);
  if (!existsSync(indexPath)) {
    return undefined;
  }

  const parsed = JSON.parse(
    await readFile(indexPath, "utf8"),
  ) as Partial<MaterializedAuthoredModuleIndex>;
  if (
    parsed.version !== 3 ||
    typeof parsed.fingerprint !== "string" ||
    parsed.fingerprint.length === 0 ||
    typeof parsed.moduleMap !== "string" ||
    parsed.moduleMap.length === 0 ||
    !isMaterializedInstrumentation(parsed.instrumentation)
  ) {
    throw new Error(`Invalid materialized authored module index at "${indexPath}".`);
  }

  return parsed as MaterializedAuthoredModuleIndex;
}

function isMaterializedInstrumentation(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<MaterializedInstrumentation>;
  if (candidate.kind === "file") {
    return typeof (candidate as { modulePath?: unknown }).modulePath === "string";
  }
  if (candidate.kind === "directory") {
    const paths = (candidate as { modulePathsBySlot?: unknown }).modulePathsBySlot;
    return (
      typeof paths === "object" &&
      paths !== null &&
      Object.values(paths).every((path) => typeof path === "string")
    );
  }

  return false;
}

async function readCompiledManifest(path: string): Promise<CompiledAgentManifest> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as CompiledAgentManifest;

  if (manifest.kind !== COMPILED_AGENT_MANIFEST_KIND) {
    throw new Error(`Invalid compiled agent manifest at "${path}".`);
  }

  return manifest;
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
