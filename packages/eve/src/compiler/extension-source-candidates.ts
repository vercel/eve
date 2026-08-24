import { extname, resolve } from "node:path";

import type {
  AgentSourceManifest,
  LocalSubagentSourceRef,
  ResolvedExtensionMount,
} from "#discover/manifest.js";
import { packageStateNamespace } from "#shared/extension-state-namespace.js";
import type {
  EffectiveAgentSourceCandidate,
  EffectiveAgentSourceKind,
  EffectiveAgentSourceRef,
} from "#compiler/effective-agent-source-graph.js";
import type { AgentSourceDescriptor, AgentSourceLayer } from "#compiler/source-composition.js";
import { canonicalAgentSourceSlot } from "#compiler/source-composition.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

type CreateCandidate = (input: {
  readonly externalDependencies: readonly string[];
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
  readonly kind: EffectiveAgentSourceKind;
  readonly layer: AgentSourceLayer;
  readonly namespace?: string;
  readonly nodeId: string;
  readonly owner: AgentSourceDescriptor["owner"];
  readonly publicName?: string;
  readonly source: EffectiveAgentSourceRef;
  readonly sourceRoot: string;
  readonly sourcePath?: string;
}) => EffectiveAgentSourceCandidate;

export function createExtensionSourceCandidates(input: {
  readonly createCandidate: CreateCandidate;
  readonly externalDependencies: readonly string[];
  readonly instrumentationProvidersEnabled?: boolean;
  readonly mount: ResolvedExtensionMount;
  readonly nodeId: string;
}): EffectiveAgentSourceCandidate[] {
  const extensionOwner = {
    kind: "extension" as const,
    namespace: input.mount.namespace,
    packageName: input.mount.packageName,
  };
  const result = createExtensionManifestCandidates({
    createCandidate: input.createCandidate,
    externalDependencies: mergeExternalDependencies(
      input.externalDependencies,
      input.mount.externalDependencies,
    ),
    instrumentationProvidersEnabled: input.instrumentationProvidersEnabled,
    layer: "extension-package",
    manifest: input.mount.manifest,
    mount: input.mount,
    nodeId: input.nodeId,
    owner: extensionOwner,
    sourceIdPrefix: `ext:${input.mount.namespace}`,
    sourceRoot: input.mount.sourceRoot,
  });
  if (input.mount.overrides !== undefined) {
    result.push(
      ...createExtensionManifestCandidates({
        createCandidate: input.createCandidate,
        externalDependencies: input.externalDependencies,
        instrumentationProvidersEnabled: input.instrumentationProvidersEnabled,
        layer: "extension-override",
        manifest: input.mount.overrides,
        mount: input.mount,
        nodeId: input.nodeId,
        owner: { kind: "application" },
        sourceIdPrefix: `ext-override:${input.mount.namespace}`,
        sourceRoot: input.mount.overrides.agentRoot,
      }),
    );
  }
  return result;
}

function mergeExternalDependencies(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())].sort((left, right) => left.localeCompare(right));
}

function createExtensionManifestCandidates(input: {
  readonly createCandidate: CreateCandidate;
  readonly externalDependencies: readonly string[];
  readonly instrumentationProvidersEnabled?: boolean;
  readonly layer: "extension-package" | "extension-override";
  readonly manifest: AgentSourceManifest;
  readonly mount: ResolvedExtensionMount;
  readonly nodeId: string;
  readonly owner: AgentSourceDescriptor["owner"];
  readonly sourceIdPrefix: string;
  readonly sourceRoot: string;
}): EffectiveAgentSourceCandidate[] {
  const result: EffectiveAgentSourceCandidate[] = [];
  const extensionScope =
    input.owner.kind === "extension"
      ? {
          namespace: packageStateNamespace(input.mount.packageName),
          sourceRoot: input.mount.sourceRoot,
        }
      : undefined;
  const add = (kind: EffectiveAgentSourceKind, sources: readonly EffectiveAgentSourceRef[]) => {
    for (const original of sources) {
      const source = scopeExtensionSource(
        original,
        kind,
        input.mount.namespace,
        input.sourceIdPrefix,
      );
      const publicName = deriveExtensionPublicName(kind, source);
      result.push(
        input.createCandidate({
          externalDependencies: input.externalDependencies,
          extensionScope,
          kind,
          layer: input.layer,
          namespace: input.mount.namespace,
          nodeId: input.nodeId,
          owner: input.owner,
          publicName,
          source,
          sourceRoot: input.sourceRoot,
          sourcePath: physicalSourcePath(input.sourceRoot, original),
        }),
      );
    }
  };
  add("channel", input.manifest.channels);
  add("connection", input.manifest.connections);
  add("hook", input.manifest.hooks);
  if (input.instrumentationProvidersEnabled === true) {
    add("instrumentation", input.manifest.instrumentation.providers);
  } else if (input.manifest.instrumentation.file !== undefined) {
    add("instrumentation", [input.manifest.instrumentation.file]);
  }
  add("instructions", input.manifest.instructions);
  add("schedule", input.manifest.schedules);
  add("skill", input.manifest.skills);
  add("subagent", input.manifest.subagents);
  add("tool", input.manifest.tools);
  return result;
}

function scopeExtensionSource<T extends EffectiveAgentSourceRef>(
  source: T,
  kind: EffectiveAgentSourceKind,
  namespace: string,
  sourceIdPrefix: string,
): T {
  const logicalPath = projectExtensionLogicalPath(source.logicalPath, kind, namespace);
  const scoped = {
    ...source,
    logicalPath,
    sourceId: `${sourceIdPrefix}:${source.sourceId}`,
  } as T;
  if (isSubagent(source)) {
    return {
      ...scoped,
      manifest: scopeExtensionManifest(source.manifest, sourceIdPrefix),
      subagentId: `${namespace}__${source.subagentId}`,
    } as T;
  }
  if ("connectionName" in scoped) {
    return { ...scoped, connectionName: `${namespace}__${scoped.connectionName}` } as T;
  }
  return scoped;
}

function scopeExtensionManifest(
  manifest: AgentSourceManifest,
  sourceIdPrefix: string,
): AgentSourceManifest {
  const scope = <T extends EffectiveAgentSourceRef>(source: T): T => {
    const scoped = { ...source, sourceId: `${sourceIdPrefix}:${source.sourceId}` } as T;
    if (!isSubagent(source)) return scoped;
    return {
      ...scoped,
      manifest: scopeExtensionManifest(source.manifest, sourceIdPrefix),
    } as T;
  };
  const instrumentation: { file?: ModuleSourceRef; providers: ModuleSourceRef[] } = {
    providers: manifest.instrumentation.providers.map(scope),
  };
  if (manifest.instrumentation.file !== undefined) {
    instrumentation.file = scope(manifest.instrumentation.file);
  }
  const scopedManifest: AgentSourceManifest = {
    ...manifest,
    channels: manifest.channels.map(scope),
    connections: manifest.connections.map(scope),
    extensions: manifest.extensions.map(scope),
    hooks: manifest.hooks.map(scope),
    instrumentation,
    instructions: manifest.instructions.map(scope),
    lib: manifest.lib.map(scope),
    sandbox: manifest.sandbox === null ? null : scope(manifest.sandbox),
    sandboxWorkspaces: manifest.sandboxWorkspaces.map(scope),
    schedules: manifest.schedules.map(scope),
    skills: manifest.skills.map(scope),
    subagents: manifest.subagents.map(scope),
    tools: manifest.tools.map(scope),
  };
  if (manifest.configModule !== undefined) {
    scopedManifest.configModule = scope(manifest.configModule);
  }
  return scopedManifest;
}

function projectExtensionLogicalPath(
  logicalPath: string,
  kind: EffectiveAgentSourceKind,
  namespace: string,
): string {
  if (kind === "instrumentation") return logicalPath;
  const root = sourceKindRoot(kind);
  const prefix = `${root}/`;
  if (logicalPath.startsWith(prefix)) {
    const relativePath = logicalPath.slice(prefix.length);
    const separator = relativePath.indexOf("/");
    const firstSegment = separator === -1 ? relativePath : relativePath.slice(0, separator);
    const rest = separator === -1 ? "" : relativePath.slice(separator);
    return `${prefix}${namespace}__${firstSegment}${rest}`;
  }
  if (kind === "instructions") {
    const extension = extname(logicalPath);
    const name = logicalPath.slice(0, extension.length === 0 ? undefined : -extension.length);
    return `instructions/${namespace}__${name}${extension}`;
  }
  throw new Error(`Cannot project extension ${kind} source "${logicalPath}".`);
}

function deriveExtensionPublicName(
  kind: EffectiveAgentSourceKind,
  source: EffectiveAgentSourceRef,
): string | undefined {
  if (kind === "subagent" && isSubagent(source)) return source.subagentId;
  const slot = canonicalAgentSourceSlot(source.logicalPath);
  let local = slot.includes("/") ? slot.slice(slot.indexOf("/") + 1) : slot;
  if (kind === "skill") local = local.replace(/\/SKILL$/i, "");
  return kind === "tool" ? local.replaceAll("/", "-") : local;
}

function sourceKindRoot(kind: EffectiveAgentSourceKind): string {
  switch (kind) {
    case "channel":
      return "channels";
    case "connection":
      return "connections";
    case "hook":
      return "hooks";
    case "instructions":
      return "instructions";
    case "schedule":
      return "schedules";
    case "skill":
      return "skills";
    case "subagent":
      return "subagents";
    case "tool":
      return "tools";
    default:
      throw new Error(`Source kind "${kind}" cannot be projected from an extension root.`);
  }
}

function physicalSourcePath(sourceRoot: string, source: EffectiveAgentSourceRef): string {
  return "sourceKind" in source && source.sourceKind === "skill-package"
    ? source.skillFilePath
    : resolve(sourceRoot, source.logicalPath);
}

function isSubagent(source: EffectiveAgentSourceRef): source is LocalSubagentSourceRef {
  return "manifest" in source && "subagentId" in source;
}
