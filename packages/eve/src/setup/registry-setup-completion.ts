import type {
  RegistrySetupCompletion,
  RegistrySetupDestination,
  RegistrySetupFact,
} from "./registry-setup-protocol.js";

/** Creates an empty registry setup completion. */
export function emptyRegistrySetupCompletion(): RegistrySetupCompletion {
  return { facts: [] };
}

/** Combines setup completions while preserving facts and deduplicating destinations by URL. */
export function mergeRegistrySetupCompletions(
  ...completions: readonly RegistrySetupCompletion[]
): RegistrySetupCompletion {
  const facts = completions.flatMap((completion) => completion.facts);
  const destinations = uniqueDestinations(
    completions.flatMap((completion) => completion.deployment?.productionDestinations ?? []),
  );
  const deploymentRequired = completions.some((completion) => completion.deployment !== undefined);
  if (!deploymentRequired) return { facts };
  const deployment: NonNullable<RegistrySetupCompletion["deployment"]> = { required: true };
  if (destinations.length > 0) deployment.productionDestinations = destinations;
  return { facts, deployment };
}

/** Adds destination links to the durable facts shown when a setup session finishes. */
export function registrySetupCompletionFacts(
  completion: RegistrySetupCompletion,
): readonly RegistrySetupFact[] {
  const destinations = completion.deployment?.productionDestinations ?? [];
  const knownUrls = new Set(
    completion.facts.filter((fact) => fact.kind === "url").map((fact) => fact.value),
  );
  return [
    ...completion.facts,
    ...destinations
      .filter((destination) => !knownUrls.has(destination.url))
      .map((destination) => ({
        label: destination.label,
        value: destination.url,
        kind: "url" as const,
      })),
  ];
}

function uniqueDestinations(
  destinations: readonly RegistrySetupDestination[],
): readonly RegistrySetupDestination[] {
  const seen = new Set<string>();
  return destinations.filter((destination) => {
    if (seen.has(destination.url)) return false;
    seen.add(destination.url);
    return true;
  });
}
