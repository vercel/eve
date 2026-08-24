import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ChannelSourceRef } from "#discover/manifest.js";
import { normalizeChannelDefinition } from "#internal/authored-definition/channel.js";
import { type ChannelRouteMethod, isDisabledRouteSentinel } from "#public/definitions/channel.js";
import type { CompiledChannelDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";

/**
 * Compiles one selected channel module into the normalized channel candidates
 * used to construct the compiler-owned route plan.
 *
 * Recognizes the `disableRoute()` sentinel and emits a `disabled` marker
 * consumed during source normalization. Disabled markers never enter the
 * compiled manifest.
 *
 * Channels are always `CompiledChannel` values (from `defineChannel`). Each
 * route in the channel's `routes` array becomes a separate compiled route
 * candidate. The channel name is derived from the filesystem path; the URL
 * path comes from the route's `path` field.
 */
export async function compileChannelDefinition(
  source: ChannelSourceRef,
  options: ModuleBackedDefinitionLoadOptions & { readonly name?: string },
): Promise<CompiledChannelCandidate | readonly CompiledChannelCandidate[]> {
  const rawValue = await loadModuleBackedDefinition({
    binding: options.binding,
    kind: "channel",
    moduleLoader: options.moduleLoader,
    source,
  });

  const channelName =
    options.name ?? stripLogicalPathExtension(source.logicalPath).replace(/^channels\//, "");

  if (isDisabledRouteSentinel(rawValue)) {
    return {
      kind: "disabled",
      name: channelName,
      logicalPath: source.logicalPath,
    };
  }

  const definition = normalizeChannelDefinition(
    rawValue,
    `Expected the channel export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  return definition.routes.map((route) => ({
    kind: "channel" as const,
    name: channelName,
    logicalPath: source.logicalPath,
    method: route.method.toUpperCase() as ChannelRouteMethod,
    urlPath: route.path,
    sourceId: source.sourceId,
    sourceKind: "module" as const,
    exportName: source.exportName,
    adapterKind: extractAdapterKind(definition.adapter),
    cors: definition.cors,
  }));
}

type CompiledChannelCandidate =
  | CompiledChannelDefinition
  | {
      readonly kind: "disabled";
      readonly logicalPath: string;
      readonly name: string;
    };

function extractAdapterKind(adapter: unknown): string | undefined {
  if (adapter === null || typeof adapter !== "object") {
    return undefined;
  }
  const kind = (adapter as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}
