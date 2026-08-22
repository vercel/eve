import { stripLogicalPathExtension } from "#discover/filesystem.js";

/**
 * The complete set of capabilities implemented by eve's native execution kernel.
 * Everything else enters the runtime through compiled agent sources.
 */
export const KERNEL_CAPABILITY_NAMES = [
  "agent",
  "task_cancel",
  "task_update",
  "ask_question",
  "load_skill",
  "web_search",
  "Workflow",
  "final_output",
] as const;

export type KernelCapabilityName = (typeof KERNEL_CAPABILITY_NAMES)[number];

export interface KernelCapabilityDefinition {
  readonly audience: "all-sessions" | "root-node" | "task-child" | "turn-output";
  readonly canonicalPath: `tools/${string}.ts`;
  readonly materialization: "harness" | "provider" | "runtime-action" | "tool-loop";
  readonly replacement: "authored-source" | "reserved";
}

/** Metadata only: implementations remain isolated in their primitive-specific modules. */
export const KERNEL_CAPABILITIES: Readonly<
  Record<KernelCapabilityName, KernelCapabilityDefinition>
> = {
  agent: {
    audience: "root-node",
    canonicalPath: "tools/agent.ts",
    materialization: "runtime-action",
    replacement: "authored-source",
  },
  task_cancel: {
    audience: "root-node",
    canonicalPath: "tools/task_cancel.ts",
    materialization: "runtime-action",
    replacement: "authored-source",
  },
  task_update: {
    audience: "task-child",
    canonicalPath: "tools/task_update.ts",
    materialization: "runtime-action",
    replacement: "authored-source",
  },
  ask_question: {
    audience: "all-sessions",
    canonicalPath: "tools/ask_question.ts",
    materialization: "harness",
    replacement: "authored-source",
  },
  load_skill: {
    audience: "all-sessions",
    canonicalPath: "tools/load_skill.ts",
    materialization: "harness",
    replacement: "authored-source",
  },
  web_search: {
    audience: "all-sessions",
    canonicalPath: "tools/web_search.ts",
    materialization: "provider",
    replacement: "authored-source",
  },
  Workflow: {
    audience: "all-sessions",
    canonicalPath: "tools/workflow.ts",
    materialization: "tool-loop",
    replacement: "authored-source",
  },
  final_output: {
    audience: "turn-output",
    canonicalPath: "tools/final_output.ts",
    materialization: "tool-loop",
    replacement: "reserved",
  },
};

const KERNEL_CAPABILITY_NAMES_SET: ReadonlySet<string> = new Set(KERNEL_CAPABILITY_NAMES);
export const RESERVED_KERNEL_CAPABILITY_NAMES: readonly KernelCapabilityName[] =
  KERNEL_CAPABILITY_NAMES.filter((name) => KERNEL_CAPABILITIES[name].replacement === "reserved");
const KERNEL_CAPABILITIES_BY_PATH: ReadonlyMap<string, KernelCapabilityName> = new Map(
  KERNEL_CAPABILITY_NAMES.map(
    (name) => [stripLogicalPathExtension(KERNEL_CAPABILITIES[name].canonicalPath), name] as const,
  ),
);
const REPLACEABLE_KERNEL_CAPABILITIES_BY_PATH: ReadonlyMap<string, KernelCapabilityName> = new Map(
  KERNEL_CAPABILITY_NAMES.filter(
    (name) => KERNEL_CAPABILITIES[name].replacement === "authored-source",
  ).map(
    (name) => [stripLogicalPathExtension(KERNEL_CAPABILITIES[name].canonicalPath), name] as const,
  ),
);

export function isKernelCapabilityName(value: string): value is KernelCapabilityName {
  return KERNEL_CAPABILITY_NAMES_SET.has(value);
}

export function getReplaceableKernelCapabilityAtPath(
  logicalPath: string,
): KernelCapabilityName | undefined {
  return REPLACEABLE_KERNEL_CAPABILITIES_BY_PATH.get(stripLogicalPathExtension(logicalPath));
}

export function getKernelCapabilityAtPath(logicalPath: string): KernelCapabilityName | undefined {
  return KERNEL_CAPABILITIES_BY_PATH.get(stripLogicalPathExtension(logicalPath));
}

export function hasKernelCapability(
  capabilities: readonly KernelCapabilityName[],
  name: KernelCapabilityName,
): boolean {
  return capabilities.includes(name);
}
