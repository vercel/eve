import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import semver from "#compiled/semver/index.js";
import { z } from "#compiled/zod/index.js";
import { formatValidationError } from "#runtime/validation.js";

export const EXTENSION_COMPATIBILITY_MANIFEST_KIND = "eve-extension";
export const EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION = 3;
export const EXTENSION_COMPATIBILITY_MANIFEST_FILENAME = "_manifest.json";

/** A legacy distribution must be rebuilt before its contents can be mounted. */
export class UnsupportedExtensionManifestVersionError extends Error {}

// Generation 0 starts with the new manifest format. Retain it at 1.0 if the
// release candidate's distribution contract remains compatible; otherwise
// advance the producer generation and explicitly choose consumer support.
export const EXTENSION_DISTRIBUTION_CONTRACT_MAJOR = 0;
export const SUPPORTED_EXTENSION_DISTRIBUTION_CONTRACT_MAJORS: readonly number[] = [0];

/** Metadata at the root of a built extension distribution. */
export interface ExtensionCompatibilityManifest {
  readonly kind: typeof EXTENSION_COMPATIBILITY_MANIFEST_KIND;
  readonly formatVersion: typeof EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION;
  /** Minimum compatible eve release: the version used to build the extension. */
  readonly builtWithEve: string;
  readonly contractMajor: number;
  readonly build?: { readonly externalDependencies: readonly string[] };
}

export type ExtensionVersionIncompatibility =
  | { readonly kind: "newer-eve"; readonly minimumVersion: string }
  | { readonly kind: "unsupported-contract"; readonly contractMajor: number };

/** Checks the distribution before loading authored extension code. */
export function checkExtensionVersionCompatibility(
  manifest: ExtensionCompatibilityManifest,
  consumerVersion: string,
  supportedMajors: readonly number[] = SUPPORTED_EXTENSION_DISTRIBUTION_CONTRACT_MAJORS,
): ExtensionVersionIncompatibility | undefined {
  if (!supportedMajors.includes(manifest.contractMajor)) {
    return { kind: "unsupported-contract", contractMajor: manifest.contractMajor };
  }
  if (
    semver.valid(consumerVersion) === null ||
    !semver.gte(consumerVersion, manifest.builtWithEve)
  ) {
    return { kind: "newer-eve", minimumVersion: manifest.builtWithEve };
  }
  return undefined;
}

const extensionCompatibilityManifestSchema: z.ZodType<ExtensionCompatibilityManifest> = z
  .object({
    kind: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_KIND),
    formatVersion: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION),
    builtWithEve: z
      .string()
      .refine((version) => semver.valid(version) !== null, "Invalid eve version"),
    contractMajor: z.number().int().nonnegative(),
    build: z
      .object({ externalDependencies: z.array(z.string().min(1)).readonly() })
      .strict()
      .optional(),
  })
  .strict();

export function serializeExtensionCompatibilityManifest(
  manifest: ExtensionCompatibilityManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

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

  if (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === EXTENSION_COMPATIBILITY_MANIFEST_KIND &&
    "formatVersion" in value &&
    (value.formatVersion === 1 || value.formatVersion === 2)
  ) {
    throw new UnsupportedExtensionManifestVersionError(
      `Extension compatibility manifest "${manifestPath}" uses the old epoch format.`,
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

export async function readExtensionCompatibilityManifest(
  manifestPath: string,
): Promise<ExtensionCompatibilityManifest> {
  return parseExtensionCompatibilityManifest(await readFile(manifestPath, "utf8"), manifestPath);
}

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
