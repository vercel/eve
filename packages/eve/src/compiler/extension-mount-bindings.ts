import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { AgentModuleBinding } from "#compiler/source-graph.js";

/** Mount association is independent of ownership: overrides stay application-owned. */
export function bindingMountId(binding: AgentModuleBinding): string | undefined {
  return binding.backing.mountId;
}

export function extensionOverridePaths(
  manifest: CompiledAgentManifest,
): ReadonlyMap<string, string> {
  return new Map(
    [manifest, ...manifest.subagents.map((node) => node.agent)].flatMap((node) =>
      [
        ...Object.values(node.bindings),
        ...node.remoteAgents.map((remote) => remote.binding),
      ].flatMap((binding) =>
        binding.backing.kind === "filesystem" &&
        binding.owner.kind === "application" &&
        bindingMountId(binding) !== undefined
          ? [[binding.backing.sourcePath, bindingMountId(binding)!] as const]
          : [],
      ),
    ),
  );
}
