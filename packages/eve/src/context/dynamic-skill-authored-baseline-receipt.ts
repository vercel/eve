import type { DurableDynamicSkillBaselineFileMetadata } from "#context/keys.js";
import { isSafeMaterializedSkillPackageFilePath } from "#shared/skill-package.js";

const RECEIPT_VERSION = 1;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export function authoredBaselineReceiptPath(input: {
  readonly directory: string;
  readonly name: string;
}): string {
  return `${input.directory}/${input.name}.receipt.json`;
}

export function serializeAuthoredBaselineReceipt(input: {
  readonly baseline: readonly DurableDynamicSkillBaselineFileMetadata[];
  readonly sandboxId: string;
}): string {
  return `${JSON.stringify({ ...input, version: RECEIPT_VERSION })}\n`;
}

export function parseAuthoredBaselineReceipt(
  value: unknown,
  sandboxId: string,
): readonly DurableDynamicSkillBaselineFileMetadata[] | undefined {
  if (!isRecord(value) || value.version !== RECEIPT_VERSION) return undefined;
  if (value.sandboxId !== sandboxId || !Array.isArray(value.baseline)) return undefined;
  const baseline: DurableDynamicSkillBaselineFileMetadata[] = [];
  for (const entry of value.baseline) {
    if (!isRecord(entry)) return undefined;
    if (
      typeof entry.relativePath !== "string" ||
      !isSafeMaterializedSkillPackageFilePath(entry.relativePath) ||
      typeof entry.contentDigest !== "string" ||
      !SHA256_HEX.test(entry.contentDigest)
    )
      return undefined;
    baseline.push({ contentDigest: entry.contentDigest, relativePath: entry.relativePath });
  }
  if (
    !baseline.some((file) => file.relativePath === "SKILL.md") ||
    new Set(baseline.map((file) => file.relativePath)).size !== baseline.length
  )
    return undefined;
  return baseline.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
