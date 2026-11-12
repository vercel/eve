import { type Harness, isHarness } from "#public/definitions/harness.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/** What a module that doesn't export a `defineHarness()` value reads. */
export function harnessMismatch(source: Pick<ModuleSourceRef, "exportName" | "logicalPath">) {
  const which =
    source.exportName === undefined || source.exportName === "default"
      ? "the default export"
      : `the export "${source.exportName}"`;
  return `Expected ${which} of "${source.logicalPath}" to be created with defineHarness().`;
}

/** A harness export, checked: `harness.ts` default-exports a `defineHarness()` value. */
export function normalizeHarness(value: unknown, message: string): Harness {
  if (!isHarness(value)) throw new Error(message);
  return value;
}
