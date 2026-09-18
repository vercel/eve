import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { formatValidationError } from "#runtime/validation.js";

/** Stable kind for an extension distribution compatibility manifest. */
export const EXTENSION_COMPATIBILITY_MANIFEST_KIND = "eve-extension";

/** Current compatibility-manifest JSON format. */
export const EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION = 2;

/** Filename emitted at the root of an extension's agent-shaped dist tree. */
export const EXTENSION_COMPATIBILITY_MANIFEST_FILENAME = "_manifest.json";

interface ExtensionCapabilityContract {
  readonly current: number;
  readonly supported: readonly number[];
  readonly dropped: Readonly<Record<number, string>>;
}

const EXTENSION_CAPABILITY_CONTRACTS = {
  extension: { current: 1, supported: [1], dropped: {} },
  tool: {
    current: 53,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 29, 30, 31, 32, 34, 35, 53],
    dropped: {
      14: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      15: "TaskExec replaces stageEffect with send",
      16: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      17: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      18: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      19: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      20: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      21: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      22: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      23: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      24: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      25: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      26: "Background tools now use task yield descriptors",
      27: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      28: "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      33: "ctx.agent now accepts the subagent name as its first argument, derives invocation identity internally, and infers structured output types",
      36: "experimental_workflow and eve/tools/workflow were removed; migrate to the workflow factory from eve/tools/workflow",
      37: "experimental_workflow and eve/tools/workflow were removed; migrate to the workflow factory from eve/tools/workflow",
      38: "experimental_workflow and eve/tools/workflow were removed; migrate to the workflow factory from eve/tools/workflow",
      39: "experimental_workflow and eve/tools/workflow were removed; migrate to the workflow factory from eve/tools/workflow",
      40: "runWorkflowProgram was made internal; use the workflow factory from eve/tools/workflow",
      41: "workflow no longer accepts agents and its options argument is optional; use workflow() or workflow({ maxSubagents })",
      42: "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      43: "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      44: "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      45: "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      46: "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      47: "eve/experimental/evaluate was removed; import evaluate from eve/ai",
      48: "eve/experimental/evaluate was removed; import evaluate from eve/ai",
      49: "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      50: "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      51: "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
      52: "Background defineTool and TaskExec were removed; use defineWorkflowTool for durable background work.",
    },
  },
  dynamicTool: {
    current: 52,
    supported: [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 31, 32, 33, 52,
    ],
    dropped: {
      21: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      23: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      24: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      25: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      26: "Background tools now use task yield descriptors",
      27: "TaskExec.delegated was removed; migrate to workflow-backed background tools",
      28: "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      29: "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      30: "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      34: "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      35: "workflowMaxSubagents was removed with experimental_workflow; configure generated-program limits with the workflow factory",
      36: "workflowMaxSubagents was removed with experimental_workflow; configure generated-program limits with the workflow factory",
      37: "workflowMaxSubagents was removed with experimental_workflow; configure generated-program limits with the workflow factory",
      38: "workflowMaxSubagents was removed with experimental_workflow; configure generated-program limits with the workflow factory",
      39: "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      40: "Legacy session history migration was removed; user-role messages require current provenance kinds.",
      41: "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      42: "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      43: "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      44: "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      45: "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      46: "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      47: "autoModel and eve/experimental/evaluate were removed; import auto from eve/models",
      48: "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      49: "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      50: "Background dynamic tools were removed; use a static defineWorkflowTool for durable background work.",
      51: "Background subagent admission now emits subagent.admitted; subagent.completed carries only successful invocation results.",
    },
  },
  channel: {
    current: 28,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 28],
    dropped: {
      12: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      19: "Continuation rekey was removed; channel extensions must use additive continuation.alias instead.",
      20: "Continuation rekey was removed; channel extensions must use additive continuation.alias instead.",
      21: "Continuation rekey was removed; channel extensions must use additive continuation.alias instead.",
      22: "Continuation rekey was removed; channel extensions must use additive continuation.alias instead.",
      23: "Task views no longer expose executor bindings; background work is owned by workflow runs.",
      24: "Task views no longer expose executor bindings; background work is owned by workflow runs.",
      25: "Task views no longer expose executor bindings; background work is owned by workflow runs.",
      26: "Task views no longer expose executor bindings; background work is owned by workflow runs.",
      27: "Background subagent admission now emits subagent.admitted; subagent.completed carries only successful invocation results.",
    },
  },
  schedule: {
    current: 15,
    supported: [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15],
    dropped: {
      5: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      14: "Background subagent admission now emits subagent.admitted; subagent.completed carries only successful invocation results.",
    },
  },
  subagent: {
    current: 20,
    supported: [3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20],
    dropped: {
      1: "Persistent subagent sessions are now the default and the experimental opt-in was removed",
      2: "Persistent subagent sessions are now the default and the experimental opt-in was removed",
      5: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      17: "Removed experimental.instrumentationProviders; instrumentation is now always enabled for root agents.",
      18: "Removed experimental.instrumentationProviders; instrumentation is now always enabled for root agents.",
      19: "Background subagent admission now emits subagent.admitted; subagent.completed carries only successful invocation results.",
    },
  },
  connection: {
    current: 24,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24],
    dropped: {
      9: "Dynamic connection resolvers no longer receive conversation or channel continuation data",
      10: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      23: "Background subagent admission now emits subagent.admitted; subagent.completed carries only successful invocation results.",
    },
  },
  hook: {
    current: 25,
    supported: [10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 25],
    dropped: {
      1: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      2: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      3: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      4: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      5: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      6: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      7: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      8: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      9: "Model identity moved from session.started runtime metadata to step.started call attribution.",
      16: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      24: "Background subagent admission now emits subagent.admitted; subagent.completed carries only successful invocation results.",
    },
  },
  skill: { current: 1, supported: [1], dropped: {} },
  dynamicSkill: {
    current: 22,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 22],
    dropped: {
      13: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      21: "Background subagent admission now emits subagent.admitted; subagent.completed carries only successful invocation results.",
    },
  },
  instructions: { current: 2, supported: [1, 2], dropped: {} },
  dynamicInstructions: {
    current: 23,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 23],
    dropped: {
      14: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
      22: "Background subagent admission now emits subagent.admitted; subagent.completed carries only successful invocation results.",
    },
  },
  config: { current: 1, supported: [1], dropped: {} },
  state: { current: 6, supported: [1, 2, 3, 4, 5, 6], dropped: {} },
} as const satisfies Record<string, ExtensionCapabilityContract>;

/** One independently versioned extension-facing contract. */
export type ExtensionCapability = keyof typeof EXTENSION_CAPABILITY_CONTRACTS;

/** Current producer contract version for each extension-facing capability. */
export const EXTENSION_CAPABILITY_VERSIONS = Object.fromEntries(
  Object.entries(EXTENSION_CAPABILITY_CONTRACTS).map(([capability, contract]) => [
    capability,
    contract.current,
  ]),
) as {
  readonly [
    TCapability in ExtensionCapability
  ]: (typeof EXTENSION_CAPABILITY_CONTRACTS)[TCapability]["current"];
};

/** Capability requirements stamped by one extension build. */
export type ExtensionCapabilityRequirements = Partial<Record<ExtensionCapability, number>>;

/**
 * Capability contract versions this eve release can consume.
 */
export const EXTENSION_CAPABILITY_SUPPORT: Readonly<
  Record<ExtensionCapability, readonly number[]>
> = (Object.keys(EXTENSION_CAPABILITY_CONTRACTS) as ExtensionCapability[]).reduce(
  (support, capability) => {
    support[capability] = EXTENSION_CAPABILITY_CONTRACTS[capability].supported;
    return support;
  },
  {} as Record<ExtensionCapability, readonly number[]>,
);

/** Consumer support table used to validate one extension distribution. */
export type ExtensionCapabilitySupport = Readonly<Record<string, readonly number[]>>;

/** Compatibility-only metadata emitted by `eve extension build`. */
export interface ExtensionCompatibilityManifest {
  readonly kind: typeof EXTENSION_COMPATIBILITY_MANIFEST_KIND;
  readonly formatVersion: 1 | typeof EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION;
  /** Diagnostic producer version; capability requirements decide compatibility. */
  readonly builtWithEve: string;
  readonly requires: Readonly<Record<string, number>>;
  readonly build?: {
    readonly externalDependencies: readonly string[];
  };
}

/** One requirement the consuming eve cannot satisfy. */
export interface UnsupportedExtensionCapability {
  readonly capability: string;
  readonly requiredVersion: number;
  readonly supportedVersions: readonly number[];
}

const extensionCompatibilityManifestV1Schema = z
  .object({
    kind: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_KIND),
    formatVersion: z.literal(1),
    builtWithEve: z.string().min(1),
    requires: z.record(z.string(), z.number().int().positive()),
  })
  .strict();
const extensionCompatibilityManifestV2Schema = extensionCompatibilityManifestV1Schema.extend({
  formatVersion: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION),
  build: z
    .object({
      externalDependencies: z.array(z.string().min(1)).readonly(),
    })
    .strict()
    .optional(),
});
const extensionCompatibilityManifestSchema: z.ZodType<ExtensionCompatibilityManifest> = z.union([
  extensionCompatibilityManifestV1Schema,
  extensionCompatibilityManifestV2Schema,
]);

/** Serializes a compatibility manifest deterministically. */
export function serializeExtensionCompatibilityManifest(
  manifest: ExtensionCompatibilityManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parses and validates compatibility-manifest JSON. */
export function parseExtensionCompatibilityManifest(
  raw: string,
  manifestPath: string,
): ExtensionCompatibilityManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Extension compatibility manifest "${manifestPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = extensionCompatibilityManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Extension compatibility manifest "${manifestPath}" is invalid. ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Reads and validates an extension compatibility manifest. */
export async function readExtensionCompatibilityManifest(
  manifestPath: string,
): Promise<ExtensionCompatibilityManifest> {
  return parseExtensionCompatibilityManifest(await readFile(manifestPath, "utf8"), manifestPath);
}

/** Writes `_manifest.json` into an agent-shaped extension dist root. */
export async function writeExtensionCompatibilityManifest(
  distRoot: string,
  manifest: ExtensionCompatibilityManifest,
): Promise<void> {
  await writeFile(
    join(distRoot, EXTENSION_COMPATIBILITY_MANIFEST_FILENAME),
    serializeExtensionCompatibilityManifest(manifest),
    "utf8",
  );
}

/** Finds unknown or unsupported capability requirements without executing extension code. */
export function findUnsupportedExtensionCapabilities(
  manifest: ExtensionCompatibilityManifest,
  support: ExtensionCapabilitySupport = EXTENSION_CAPABILITY_SUPPORT,
): UnsupportedExtensionCapability[] {
  return Object.entries(manifest.requires)
    .flatMap(([capability, requiredVersion]) => {
      // Manifest keys are untrusted; "toString" must fail closed, not resolve
      // through the prototype chain.
      const supportedVersions = Object.hasOwn(support, capability)
        ? (support[capability] ?? [])
        : [];
      return supportedVersions.includes(requiredVersion)
        ? []
        : [{ capability, requiredVersion, supportedVersions }];
    })
    .sort((left, right) => left.capability.localeCompare(right.capability));
}
