import { describe, expect, it } from "vitest";

import { createModuleSourceRef } from "#discover/manifest.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";

const MODULE_SOURCE = createModuleSourceRef({ logicalPath: "tools/selected.ts" });

function assertModuleSourcesRequireBindings(): void {
  // @ts-expect-error Module instructions cannot normalize without their selected binding.
  void compileInstructionsEntry(MODULE_SOURCE);
  // @ts-expect-error Module schedules cannot normalize without their selected binding.
  void compileScheduleDefinition(MODULE_SOURCE);
  // @ts-expect-error Module skills cannot normalize without their selected binding.
  void compileSkillSource(MODULE_SOURCE);
}

describe("module normalizer binding types", () => {
  it("keeps module source identity distinct from non-module inputs", () => {
    expect(MODULE_SOURCE.sourceKind).toBe("module");
    expect(assertModuleSourcesRequireBindings).toBeTypeOf("function");
  });
});
