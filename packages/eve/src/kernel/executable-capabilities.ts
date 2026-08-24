import type { JsonValue } from "#shared/json.js";
import type { RuntimeActionRequest } from "#shared/runtime-actions.js";

import {
  getExecutableKernelCapabilityStrategy,
  type KernelCapabilityAdvertisementInput,
  type KernelCapabilityName,
  type KernelCapabilityPlan,
  type KernelCapabilityStrategy,
  type KernelNodeMaterializationInput,
  type KernelProviderInstallDecision,
  type KernelRuntimeCallClassificationInput,
  type KernelTaskControlOperations,
} from "#kernel/capabilities.js";

export function materializePreparedKernelNodeTools<T>(
  plan: KernelCapabilityPlan,
  input: KernelNodeMaterializationInput<T>,
): T[] {
  return plan.prepared.flatMap((name) => {
    const strategy = getExecutableKernelCapabilityStrategy(name);
    const tool = strategy.materializeNodeTool(input, strategy.name);
    return tool === undefined ? [] : [tool];
  });
}

export async function installKernelProviderTool<T>(
  name: KernelCapabilityName,
  input: {
    readonly installWebSearch: () => Promise<T>;
    readonly modelSupportsProviderTools: boolean;
  },
): Promise<KernelProviderInstallDecision<T>> {
  return getExecutableKernelCapabilityStrategy(name).installProviderTool(input);
}

export function classifyKernelRuntimeCall(
  name: KernelCapabilityName,
  input: KernelRuntimeCallClassificationInput,
): RuntimeActionRequest | undefined {
  return getExecutableKernelCapabilityStrategy(name).classifyRuntimeCall(input);
}

export function isKernelInputRequestCapability(
  name: KernelCapabilityName,
  toolName: string,
): boolean {
  const strategy = getExecutableKernelCapabilityStrategy(name);
  return strategy.selectsInputRequest && strategy.name === toolName;
}

export function isKernelTaskControlAction(name: KernelCapabilityName, toolName: string): boolean {
  const strategy = getExecutableKernelCapabilityStrategy(name);
  return strategy.selectsTaskControl && strategy.name === toolName;
}

export function dispatchKernelTaskControl<T>(
  name: KernelCapabilityName,
  operations: KernelTaskControlOperations<T>,
): Promise<T> | undefined {
  return getExecutableKernelCapabilityStrategy(name).dispatchTaskControl(operations);
}

export function getPreparedKernelActionEmissionExclusions(
  plan: KernelCapabilityPlan,
): ReadonlySet<string> {
  return new Set(
    plan.prepared.flatMap((name) => {
      const excluded = getExecutableKernelCapabilityStrategy(name).actionEmissionExclusion();
      return excluded === undefined ? [] : [excluded];
    }),
  );
}

export function isPreparedKernelTerminalOutputCall(
  plan: KernelCapabilityPlan,
  toolName: string,
): boolean {
  return plan.prepared.some((name) => {
    const strategy = getExecutableKernelCapabilityStrategy(name);
    return strategy.selectsTerminalOutput && strategy.name === toolName;
  });
}

export function usePreparedKernelWorkflow<T>(
  plan: KernelCapabilityPlan,
  operation: () => T,
): T | undefined {
  for (const name of plan.prepared) {
    const result = getExecutableKernelCapabilityStrategy(name).useWorkflow(operation);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function useAdvertisedKernelWorkflow<T>(
  plan: KernelCapabilityPlan,
  input: KernelCapabilityAdvertisementInput,
  operation: () => T,
): T | undefined {
  for (const name of plan.prepared) {
    const strategy = getExecutableKernelCapabilityStrategy(name);
    if (!strategy.advertisement(input)) continue;
    const result = strategy.useWorkflow(operation);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function installPreparedKernelTurnTool<T>(
  plan: KernelCapabilityPlan,
  input: {
    readonly installFinalOutput: (name: "final_output") => T;
    readonly structuredOutput: boolean;
  },
): T | undefined {
  for (const name of plan.prepared) {
    const strategy = getExecutableKernelCapabilityStrategy(name);
    const result = strategy.installTurnTool(input, strategy.name);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function extractPreparedKernelTerminalOutput(
  plan: KernelCapabilityPlan,
  input: Parameters<KernelCapabilityStrategy<KernelCapabilityName>["extractTerminalOutput"]>[0],
): JsonValue | undefined {
  for (const name of plan.prepared) {
    const strategy = getExecutableKernelCapabilityStrategy(name);
    const result = strategy.extractTerminalOutput(input, strategy.name);
    if (result !== undefined) return result;
  }
  return undefined;
}
