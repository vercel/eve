import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  isSafeMaterializedSkillPackageFilePath,
  isSafeSkillPackageName,
} from "#shared/skill-package.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";

const MARKER_VERSION = 1;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export const DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE = ".eve-dynamic-skill-materialization.json";

export interface DynamicSkillMaterializationMarkerEntry {
  readonly contentDigest: string;
  readonly relativePaths: readonly string[];
  readonly resolverSlug: string;
}

export interface DynamicSkillMaterializationMarker {
  readonly packages: Readonly<Record<string, DynamicSkillMaterializationMarkerEntry>>;
  readonly version: typeof MARKER_VERSION;
}

export type DynamicSkillMaterializationMarkerStatus =
  | "current"
  | "corrupt"
  | "missing"
  | "old"
  | "stale"
  | "unreadable";

export interface DynamicSkillMaterializationMarkerRead {
  readonly marker: DynamicSkillMaterializationMarker | null;
  readonly path: string;
  readonly status: DynamicSkillMaterializationMarkerStatus;
}

export async function readDynamicSkillMaterializationMarker(input: {
  readonly sandbox: SandboxSession;
}): Promise<DynamicSkillMaterializationMarkerRead> {
  const path = await resolveMarkerPath(input.sandbox);
  let raw: string | null;

  try {
    raw = await input.sandbox.readTextFile({ path });
  } catch {
    return { marker: null, path, status: "unreadable" };
  }

  if (raw === null) {
    return { marker: null, path, status: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { marker: null, path, status: "corrupt" };
  }

  if (!isRecord(parsed) || parsed.version !== MARKER_VERSION) {
    return {
      marker: null,
      path,
      status: isRecord(parsed) && "version" in parsed ? "old" : "corrupt",
    };
  }

  const marker = parseCurrentMarker(parsed);
  return marker === null
    ? { marker: null, path, status: "corrupt" }
    : { marker, path, status: "current" };
}

export async function writeDynamicSkillMaterializationMarker(input: {
  readonly marker: DynamicSkillMaterializationMarker;
  readonly path: string;
  readonly sandbox: SandboxSession;
}): Promise<void> {
  const packages = Object.fromEntries(
    Object.entries(input.marker.packages)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [
        name,
        {
          contentDigest: entry.contentDigest,
          relativePaths: [...entry.relativePaths],
          resolverSlug: entry.resolverSlug,
        },
      ]),
  );

  await input.sandbox.writeTextFile({
    content: `${JSON.stringify({ packages, version: MARKER_VERSION })}\n`,
    path: input.path,
  });
}

function parseCurrentMarker(
  value: Record<string, unknown>,
): DynamicSkillMaterializationMarker | null {
  if (!isRecord(value.packages)) return null;

  const packages: Record<string, DynamicSkillMaterializationMarkerEntry> = {};
  for (const [name, rawEntry] of Object.entries(value.packages)) {
    if (!isSafeSkillPackageName(name) || !isRecord(rawEntry)) return null;
    if (!SHA256_HEX.test(asString(rawEntry.contentDigest))) return null;
    if (asString(rawEntry.resolverSlug).length === 0) return null;
    if (!Array.isArray(rawEntry.relativePaths)) return null;

    const relativePaths = rawEntry.relativePaths;
    if (
      !relativePaths.every(
        (path): path is string =>
          typeof path === "string" && isSafeMaterializedSkillPackageFilePath(path),
      ) ||
      new Set(relativePaths).size !== relativePaths.length
    ) {
      return null;
    }

    packages[name] = {
      contentDigest: rawEntry.contentDigest as string,
      relativePaths: [...relativePaths].sort(),
      resolverSlug: rawEntry.resolverSlug as string,
    };
  }

  return { packages, version: MARKER_VERSION };
}

async function resolveMarkerPath(sandbox: SandboxSession): Promise<string> {
  const root = await resolveSandboxSkillRoot({ sandbox });
  return `${root}/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
