import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { formatValidationError } from "#runtime/validation.js";

/** Stable kind for an extension distribution compatibility manifest. */
export const EXTENSION_COMPATIBILITY_MANIFEST_KIND = "eve-extension";

/** Current compatibility-manifest JSON format. */
export const EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION = 1;

/** Filename emitted at the root of an extension's agent-shaped dist tree. */
export const EXTENSION_COMPATIBILITY_MANIFEST_FILENAME = "_manifest.json";

interface ExtensionCapabilityContract {
  readonly current: number;
  readonly supported: readonly number[];
  readonly dropped: Readonly<Record<number, string>>;
}

const EXTENSION_CAPABILITY_CONTRACTS = {
  extension: { current: 1, supported: [1], dropped: {} },
  tool: { current: 2, supported: [1, 2], dropped: {} },
  dynamicTool: { current: 3, supported: [1, 2, 3], dropped: {} },
  connection: { current: 2, supported: [1, 2], dropped: {} },
  hook: { current: 2, supported: [1, 2], dropped: {} },
  skill: { current: 1, supported: [1], dropped: {} },
  dynamicSkill: { current: 1, supported: [1], dropped: {} },
  instructions: { current: 1, supported: [1], dropped: {} },
  dynamicInstructions: { current: 1, supported: [1], dropped: {} },
  config: { current: 1, supported: [1], dropped: {} },
  state: { current: 2, supported: [1, 2], dropped: {} },
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
  readonly [TCapability in ExtensionCapability]: (typeof EXTENSION_CAPABILITY_CONTRACTS)[TCapability]["current"];
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
  readonly formatVersion: typeof EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION;
  /** Diagnostic producer version; capability requirements decide compatibility. */
  readonly builtWithEve: string;
  readonly requires: Readonly<Record<string, number>>;
}

/** One requirement the consuming eve cannot satisfy. */
export interface UnsupportedExtensionCapability {
  readonly capability: string;
  readonly requiredVersion: number;
  readonly supportedVersions: readonly number[];
}

const extensionCompatibilityManifestSchema: z.ZodType<ExtensionCompatibilityManifest> = z
  .object({
    kind: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_KIND),
    formatVersion: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION),
    builtWithEve: z.string().min(1),
    requires: z.record(z.string(), z.number().int().positive()),
  })
  .strict();

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
