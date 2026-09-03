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
    current: 27,
    supported: [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
    ],
    dropped: { 15: "TaskExec replaces stageEffect with send" },
  },
  dynamicTool: {
    current: 27,
    supported: [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27,
    ],
    dropped: {
      21: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
    },
  },
  channel: {
    current: 16,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16],
    dropped: {
      12: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
    },
  },
  schedule: {
    current: 9,
    supported: [1, 2, 3, 4, 6, 7, 8, 9],
    dropped: {
      5: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
    },
  },
  subagent: {
    current: 8,
    supported: [3, 4, 6, 7, 8],
    dropped: {
      1: "Persistent subagent sessions are now the default and the experimental opt-in was removed",
      2: "Persistent subagent sessions are now the default and the experimental opt-in was removed",
      5: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
    },
  },
  connection: {
    current: 14,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14],
    dropped: {
      9: "Dynamic connection resolvers no longer receive conversation or channel continuation data",
      10: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
    },
  },
  hook: {
    current: 20,
    supported: [10, 11, 12, 13, 14, 15, 17, 18, 19, 20],
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
    },
  },
  skill: { current: 1, supported: [1], dropped: {} },
  dynamicSkill: {
    current: 16,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16],
    dropped: {
      13: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
    },
  },
  instructions: { current: 2, supported: [1, 2], dropped: {} },
  dynamicInstructions: {
    current: 17,
    supported: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17],
    dropped: {
      14: "Message and reasoning append events now expose deltas instead of cumulative snapshots.",
    },
  },
  config: { current: 1, supported: [1], dropped: {} },
  state: { current: 5, supported: [1, 2, 3, 4, 5], dropped: {} },
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
