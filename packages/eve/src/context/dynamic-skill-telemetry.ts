import type { DynamicSkillMaterializationResult } from "#context/dynamic-skill-materialization.js";
import { createLogger } from "#internal/logging.js";
import type { MaterializableSkillPackage } from "#shared/skill-package.js";

const log = createLogger("dynamic-skills");

/** Emits one content-free lifecycle summary for latency diagnosis. */
export function logDynamicSkillMaterializationTelemetry(input: {
  readonly announcementMs: number;
  readonly eventType: string;
  readonly materialization: DynamicSkillMaterializationResult | undefined;
  readonly packages: readonly MaterializableSkillPackage[];
  readonly resolverCount: number;
  readonly resolverMs: number;
  readonly sandboxMs: number;
  readonly totalMs: number;
}): void {
  log.info("Dynamic skill lifecycle completed.", {
    addedPackageCount: input.materialization?.addedPackageCount ?? 0,
    announcementMs: roundMs(input.announcementMs),
    changedPackageCount: input.materialization?.changedPackageCount ?? 0,
    eventType: input.eventType,
    fileCount: input.packages.reduce((total, skill) => total + skill.files.length, 0),
    fullRematerialization: input.materialization?.fullRematerialization ?? false,
    markerMs: roundMs(input.materialization?.markerMs ?? 0),
    markerStatus: input.materialization?.markerStatus ?? "no-sandbox",
    markerWriteCount: input.materialization?.markerWriteCount ?? 0,
    markerWriteMs: roundMs(input.materialization?.markerWriteMs ?? 0),
    packageCount: input.packages.length,
    removeCallCount: input.materialization?.removeCallCount ?? 0,
    removeMs: roundMs(input.materialization?.removeMs ?? 0),
    removedPackageCount: input.materialization?.removedPackageCount ?? 0,
    resolverCount: input.resolverCount,
    resolverMs: roundMs(input.resolverMs),
    sandboxMs: roundMs(input.sandboxMs),
    sourceByteCount: input.packages.reduce(
      (total, skill) =>
        total + skill.files.reduce((fileTotal, file) => fileTotal + file.content.byteLength, 0),
      0,
    ),
    totalMs: roundMs(input.totalMs),
    unchangedPackageCount: input.materialization?.unchangedPackageCount ?? 0,
    writeByteCount: input.materialization?.writeByteCount ?? 0,
    writeFileCount: input.materialization?.writeFileCount ?? 0,
    writeMs: roundMs(input.materialization?.writeMs ?? 0),
    writePackageCount: input.materialization?.writePackageCount ?? 0,
  });
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
