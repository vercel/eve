import type { RegistrySetupCompletion } from "./registry-setup-protocol.js";

export function mergeRegistrySetupCompletions(
  ...completions: readonly RegistrySetupCompletion[]
): RegistrySetupCompletion {
  const facts = completions.flatMap((completion) => completion.facts);
  return completions.some((completion) => completion.deploymentRequired === true)
    ? { facts, deploymentRequired: true }
    : { facts };
}
