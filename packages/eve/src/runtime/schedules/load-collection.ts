import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import type { ScheduleSubscriptionDefinition } from "#public/schedules/subscription.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/** The agent does not deploy the named collection, or not with the expected provider. */
export class ScheduleCollectionNotDeployedError extends Error {}

/**
 * Reloads a collection's authored definition inside a durable step or queue
 * callback, where the closure that created the occurrence no longer exists.
 */
export async function loadScheduleCollectionDefinition(
  bundle: Pick<CompiledRuntimeAgentBundle, "compiledArtifactsSource" | "moduleMap" | "nodeId">,
  collection: string,
  options: { readonly manifest?: CompiledAgentManifest; readonly providerKind?: string } = {},
): Promise<ScheduleSubscriptionDefinition<unknown>> {
  const manifest =
    options.manifest ??
    (await loadCompiledManifest({ compiledArtifactsSource: bundle.compiledArtifactsSource }));
  const compiled = manifest.scheduleCollections.find(
    (item) =>
      item.name === collection &&
      (options.providerKind === undefined || item.providerKind === options.providerKind),
  );
  if (compiled === undefined)
    throw new ScheduleCollectionNotDeployedError(
      `Schedule collection "${collection}" is not deployed by this agent.`,
    );
  const exported = await loadResolvedModuleExport({
    definition: compiled,
    kindLabel: "schedule collection",
    moduleMap: bundle.moduleMap,
    nodeId: bundle.nodeId,
  });
  return normalizeScheduleCollectionDefinition(
    exported,
    `Invalid schedule collection ${collection}.`,
  ) as ScheduleSubscriptionDefinition<unknown>;
}
