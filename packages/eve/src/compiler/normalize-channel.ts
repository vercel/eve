import { stripLogicalPathExtension } from "#discover/filesystem.js";
import { normalizeChannelDefinition } from "#internal/authored-definition/channel.js";
import { type ChannelRouteMethod, isDisabledRouteSentinel } from "#public/definitions/channel.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { CompiledChannelDefinition } from "#compiler/manifest.js";

/**
 * Result of compiling one selected channel export: either the ordered
 * compiled route entries, or a `disabled` marker the composer records on
 * the node's source composition.
 */
export type CompiledChannelResult =
  | { readonly kind: "disabled"; readonly name: string }
  | { readonly kind: "channel"; readonly definitions: readonly CompiledChannelDefinition[] };

/**
 * Compiles one selected channel export into the normalized channel entries
 * stored on the compiled agent manifest.
 *
 * Authored channels are always `CompiledChannel` values (from
 * `defineChannel`). Each route in the channel's `routes` array becomes
 * a separate compiled channel entry. The channel name is derived from
 * the filesystem path; the URL path comes from the route's `path` field.
 */
export function compileChannelDefinition(
  source: ModuleSourceRef,
  exportValue: unknown,
): CompiledChannelResult {
  const channelName = stripLogicalPathExtension(source.logicalPath).replace(/^channels\//, "");

  if (isDisabledRouteSentinel(exportValue)) {
    return { kind: "disabled", name: channelName };
  }

  const definition = normalizeChannelDefinition(
    exportValue,
    `Expected the channel export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  return {
    kind: "channel",
    definitions: definition.routes.map((route) => ({
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
    })),
  };
}

function extractAdapterKind(adapter: unknown): string | undefined {
  if (adapter === null || typeof adapter !== "object") {
    return undefined;
  }
  const kind = (adapter as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}
