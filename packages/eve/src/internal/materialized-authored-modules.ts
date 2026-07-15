import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { CompiledAgentManifest, CompiledAgentNodeManifest } from "#compiler/manifest.js";
import { COMPILED_AGENT_MANIFEST_KIND, ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { collectModuleRefsForManifest } from "#compiler/module-map.js";
import { bundleAuthoredModuleForGeneration } from "#internal/authored-module-loader.js";
import { serializeCompiledManifestForFingerprint } from "#internal/compiled-manifest-fingerprint.js";

const MATERIALIZED_MODULES_DIRECTORY = "authored-modules";
const MATERIALIZED_MODULES_INDEX = "authored-modules.json";
const INSTRUMENTATION_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

export interface MaterializedAuthoredModuleIndex {
  readonly fingerprint: string;
  readonly instrumentation?: string;
  readonly nodes: Readonly<Record<string, { readonly modules: Readonly<Record<string, string>> }>>;
  readonly version: 1;
}

export async function materializeAuthoredModules(input: {
  readonly runtimeAppRoot: string;
}): Promise<MaterializedAuthoredModuleIndex> {
  const compileRoot = join(input.runtimeAppRoot, ".eve", "compile");
  const manifest = await readCompiledManifest(join(compileRoot, "compiled-agent-manifest.json"));
  const modulesRoot = join(compileRoot, MATERIALIZED_MODULES_DIRECTORY);
  const scopeIndex = createExtensionScopeIndex(manifest);
  const nodes: Record<string, { modules: Record<string, string> }> = {};
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
  for (const node of collectNodeManifests(manifest)) {
    const modules: Record<string, string> = {};

    for (const ref of collectModuleRefsForManifest(node.manifest).sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId),
    )) {
      const code = await bundleAuthoredModuleForGeneration(join(node.agentRoot, ref.logicalPath), {
        externalDependencies: node.manifest.config.build?.externalDependencies ?? [],
        extensionScopeNamespace: extensionNamespaceForSourceId(ref.sourceId, scopeIndex),
      });
      const fileName = createMaterializedModuleFileName(node.nodeId, ref.sourceId, code);

      await writeFile(join(modulesRoot, fileName), code);
      fingerprint
        .update("module\0")
        .update(node.nodeId)
        .update("\0")
        .update(ref.sourceId)
        .update("\0")
        .update(code)
        .update("\0");
      modules[ref.sourceId] = join(MATERIALIZED_MODULES_DIRECTORY, fileName);
    }

    nodes[node.nodeId] = { modules };
  }

  const instrumentation = resolveInstrumentationModule(manifest.agentRoot);
  let instrumentationPath: string | undefined;

  if (instrumentation !== undefined) {
    const code = await bundleAuthoredModuleForGeneration(instrumentation, {
      externalDependencies: manifest.config.build?.externalDependencies ?? [],
    });
    const fileName = createMaterializedModuleFileName(
      ROOT_COMPILED_AGENT_NODE_ID,
      "instrumentation",
      code,
    );

    await writeFile(join(modulesRoot, fileName), code);
    instrumentationPath = join(MATERIALIZED_MODULES_DIRECTORY, fileName);
    fingerprint.update("instrumentation\0").update(code).update("\0");
  }

  await hashDirectoryIfPresent({
    fingerprint,
    path: join(compileRoot, "workspace-resources"),
    root: join(compileRoot, "workspace-resources"),
  });
  const index: {
    fingerprint: string;
    instrumentation?: string;
    nodes: MaterializedAuthoredModuleIndex["nodes"];
    version: 1;
  } = {
    fingerprint: fingerprint.digest("hex"),
    nodes,
    version: 1,
  };
  if (instrumentationPath !== undefined) {
    index.instrumentation = instrumentationPath;
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
    parsed.version !== 1 ||
    typeof parsed.fingerprint !== "string" ||
    parsed.fingerprint.length === 0 ||
    typeof parsed.nodes !== "object" ||
    parsed.nodes === null ||
    (parsed.instrumentation !== undefined && typeof parsed.instrumentation !== "string")
  ) {
    throw new Error(`Invalid materialized authored module index at "${indexPath}".`);
  }

  return parsed as MaterializedAuthoredModuleIndex;
}

interface ExtensionScopeIndex {
  readonly byMountNamespace: ReadonlyMap<string, string>;
}

function collectNodeManifests(manifest: CompiledAgentManifest): Array<{
  readonly agentRoot: string;
  readonly manifest: CompiledAgentNodeManifest;
  readonly nodeId: string;
}> {
  return [
    { agentRoot: manifest.agentRoot, manifest, nodeId: ROOT_COMPILED_AGENT_NODE_ID },
    ...[...manifest.subagents]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((subagent) => ({
        agentRoot: subagent.agent.agentRoot,
        manifest: subagent.agent,
        nodeId: subagent.nodeId,
      })),
  ];
}

function createExtensionScopeIndex(manifest: CompiledAgentManifest): ExtensionScopeIndex {
  return {
    byMountNamespace: new Map(
      manifest.extensionMounts.map((mount) => [mount.namespace, mount.packageNamespace]),
    ),
  };
}

function extensionNamespaceForSourceId(
  sourceId: string,
  index: ExtensionScopeIndex,
): string | undefined {
  const match = sourceId.match(/^ext:([^:]+):/u);
  return match === null ? undefined : index.byMountNamespace.get(match[1]!);
}

async function readCompiledManifest(path: string): Promise<CompiledAgentManifest> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as CompiledAgentManifest;

  if (manifest.kind !== COMPILED_AGENT_MANIFEST_KIND) {
    throw new Error(`Invalid compiled agent manifest at "${path}".`);
  }

  return manifest;
}

function resolveInstrumentationModule(agentRoot: string): string | undefined {
  for (const extension of INSTRUMENTATION_EXTENSIONS) {
    const candidate = join(agentRoot, `instrumentation${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
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
