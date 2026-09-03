import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ChannelSourceRef } from "#discover/manifest.js";
import { normalizeChannelDefinition } from "#internal/authored-definition/channel.js";
import { extractVercelConnectMetadata } from "#shared/vercel-connect-metadata.js";
import { extractSlackAppManifestMetadata } from "#public/channels/slack/app-manifest.js";
import { type ChannelRouteMethod, isDisabledRouteSentinel } from "#public/definitions/channel.js";
import type { CompiledChannelDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";

/**
 * Compiles one authored channel module into the normalized channel
 * entries stored on the compiled agent manifest.
 *
 * Recognizes the `disableRoute()` sentinel and emits a `disabled`
 * entry so the runtime can short-circuit channel registration without
 * losing the source path for diagnostics.
 *
 * Authored channels are always `CompiledChannel` values (from
 * `defineChannel`). Each route in the channel's `routes` array becomes
 * a separate compiled channel entry. The channel name is derived from
 * the filesystem path; the URL path comes from the route's `path` field.
 */
export async function compileChannelDefinition(
  _agentRoot: string,
  source: ChannelSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<
  | { readonly kind: "disabled"; readonly name: string }
  | { readonly definitions: readonly CompiledChannelDefinition[]; readonly kind: "channel" }
> {
  const rawValue = await loadModuleBackedDefinition({
    binding: options.binding,
    kind: "channel",
    loadNamespace: options.loadNamespace,
    source,
  });

  const channelName = stripLogicalPathExtension(source.logicalPath).replace(/^channels\//, "");

  if (isDisabledRouteSentinel(rawValue)) {
    return { kind: "disabled", name: channelName };
  }

  const definition = normalizeChannelDefinition(
    rawValue,
    `Expected the channel export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`,
  );

  return {
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
      slackAppManifest: extractSlackAppManifestMetadata(
        rawValue === null || typeof rawValue !== "object"
          ? undefined
          : (rawValue as { readonly slackAppManifest?: unknown }).slackAppManifest,
      ),
      vercelConnect: extractVercelConnectMetadata(
        rawValue === null || typeof rawValue !== "object"
          ? undefined
          : (rawValue as { readonly vercelConnect?: unknown }).vercelConnect,
      ),
    })),
    kind: "channel",
  };
}

function extractAdapterKind(adapter: unknown): string | undefined {
  if (adapter === null || typeof adapter !== "object") {
    return undefined;
  }
  const kind = (adapter as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}
