import { KERNEL_CAPABILITY_NAMES, type KernelCapabilityName } from "#kernel/capabilities.js";

/** Compiler-owned inputs that determine the native work a node still needs. */
export interface PrepareKernelCapabilitiesInput {
  readonly disabled: ReadonlySet<KernelCapabilityName>;
  readonly frameworkLoadSkill: boolean;
  readonly hasSkills: boolean;
  readonly isRoot: boolean;
  readonly tasksEnabled: boolean;
  readonly toolNames: ReadonlySet<string>;
  readonly webSearch: boolean;
  readonly workflow: boolean;
}

/**
 * Produces the closed native plan consumed by runtime preparation. Capability
 * order follows the inventory so compiled artifacts stay deterministic.
 */
export function prepareKernelCapabilities(
  input: PrepareKernelCapabilitiesInput,
): readonly KernelCapabilityName[] {
  const prepared = new Set<KernelCapabilityName>();
  const available = (name: KernelCapabilityName): boolean =>
    !input.disabled.has(name) && !input.toolNames.has(name);

  if (input.isRoot && available("agent")) prepared.add("agent");
  if (input.isRoot && input.tasksEnabled) {
    if (available("task_cancel")) prepared.add("task_cancel");
    if (available("task_update")) prepared.add("task_update");
  }
  if (available("ask_question")) prepared.add("ask_question");
  if (input.frameworkLoadSkill && input.hasSkills) prepared.add("load_skill");
  if (input.webSearch) prepared.add("web_search");
  if (input.workflow) prepared.add("Workflow");

  return KERNEL_CAPABILITY_NAMES.filter((name) => prepared.has(name));
}
