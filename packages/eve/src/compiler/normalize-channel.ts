import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { normalizeChannelDefinition } from "#internal/authored-definition/channel.js";
import { getChannelBuildMetadata } from "#channel/compiled-channel.js";
import { extractVercelConnectMetadata } from "#shared/vercel-connect-metadata.js";
import { type ChannelRouteMethod, isDisabledRouteSentinel } from "#public/definitions/channel.js";
import type { CompiledChannelDefinition } from "#compiler/manifest.js";
import { readWorkflowFunctionId } from "#shared/workflow-function-id.js";
import { workflowCallbackErrorMessage } from "#shared/workflow-tool-context.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";

export async function compileChannelDefinition(
  _agentRoot: string,
  source: ModuleSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<
  | { readonly kind: "disabled"; readonly name: string }
  | {
      readonly definitions: readonly CompiledChannelDefinition[];
      readonly kind: "channel";
      readonly name: string;
      readonly offersSubscriptions: boolean;
    }
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

  const buildMetadata = getChannelBuildMetadata(definition, channelName);

  for (const route of definition.routes) {
    if (readWorkflowFunctionId(route.handler) !== undefined) {
      throw new Error(
        `${source.logicalPath} (${route.method} ${route.path}): ${workflowCallbackErrorMessage("channel")}`,
      );
    }
  }

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
      manifest: buildMetadata?.manifest,
      vercelConnect: extractVercelConnectMetadata(buildMetadata?.externalCredentials),
    })),
    kind: "channel",
    name: channelName,
    offersSubscriptions: definition.onEvent !== undefined,
  };
}

function extractAdapterKind(adapter: unknown): string | undefined {
  if (adapter === null || typeof adapter !== "object") {
    return undefined;
  }
  const kind = (adapter as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}
