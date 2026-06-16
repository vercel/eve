import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

export const MICROSANDBOX_METADATA_VERSION = 2;
export const MICROSANDBOX_METADATA_FILE_NAME = "metadata.json";

export interface MicrosandboxTemplateMetadata {
  readonly optionsHash: string;
  readonly snapshotName: string;
  readonly version: typeof MICROSANDBOX_METADATA_VERSION;
}

export interface MicrosandboxSessionMetadata {
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly optionsHash: string;
  readonly sandboxName: string;
  readonly stateSnapshotName?: string;
  readonly version: typeof MICROSANDBOX_METADATA_VERSION;
}

export function resolveMicrosandboxMetadataPath(rootPath: string): string {
  return join(rootPath, MICROSANDBOX_METADATA_FILE_NAME);
}

export async function readTemplateMetadata(
  path: string,
): Promise<MicrosandboxTemplateMetadata | null> {
  const metadata = await readJsonFile(path);
  if (
    metadata?.version !== MICROSANDBOX_METADATA_VERSION ||
    typeof metadata.optionsHash !== "string" ||
    typeof metadata.snapshotName !== "string"
  ) {
    return null;
  }
  return {
    optionsHash: metadata.optionsHash,
    snapshotName: metadata.snapshotName,
    version: MICROSANDBOX_METADATA_VERSION,
  };
}

export async function writeTemplateMetadata(
  path: string,
  metadata: MicrosandboxTemplateMetadata,
): Promise<void> {
  await writeJsonFileAtomically(path, metadata);
}

export async function readSessionMetadata(
  path: string,
): Promise<MicrosandboxSessionMetadata | null> {
  return readSessionMetadataRecord(await readJsonFile(path));
}

export function readSessionMetadataRecord(value: unknown): MicrosandboxSessionMetadata | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.version !== MICROSANDBOX_METADATA_VERSION ||
    typeof value.optionsHash !== "string" ||
    typeof value.sandboxName !== "string"
  ) {
    return null;
  }
  return {
    networkPolicy: value.networkPolicy as SandboxNetworkPolicy | undefined,
    optionsHash: value.optionsHash,
    sandboxName: value.sandboxName,
    stateSnapshotName:
      typeof value.stateSnapshotName === "string" ? value.stateSnapshotName : undefined,
    version: MICROSANDBOX_METADATA_VERSION,
  };
}

export async function writeSessionMetadata(
  path: string,
  metadata: MicrosandboxSessionMetadata,
): Promise<void> {
  await writeJsonFileAtomically(path, metadata);
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
