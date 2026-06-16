import { describe, expect, it } from "vitest";

import {
  CODE_MODE_SURFACE,
  WORKFLOW_SURFACE,
  isSandboxEnabled,
  selectSandboxSurfaces,
} from "#harness/sandbox-surface.js";

describe("selectSandboxSurfaces", () => {
  it("returns no surfaces when neither sandbox is enabled", () => {
    expect(selectSandboxSurfaces({})).toEqual([]);
    expect(isSandboxEnabled({})).toBe(false);
  });

  it("emits only the matching surface for each single flag", () => {
    expect(selectSandboxSurfaces({ codeMode: true })).toEqual([CODE_MODE_SURFACE]);
    expect(selectSandboxSurfaces({ workflow: true })).toEqual([WORKFLOW_SURFACE]);
  });

  it("emits both surfaces when both are enabled", () => {
    expect(selectSandboxSurfaces({ codeMode: true, workflow: true })).toEqual([
      WORKFLOW_SURFACE,
      CODE_MODE_SURFACE,
    ]);
    expect(isSandboxEnabled({ codeMode: true, workflow: true })).toBe(true);
  });
});

describe("sandbox surface claims", () => {
  const subagentTool = { runtimeAction: { kind: "subagent-call" } } as never;

  it("Workflow claims only runtime-action (agent) tools", () => {
    expect(WORKFLOW_SURFACE.claims(subagentTool, {} as never)).toBe(true);
    expect(WORKFLOW_SURFACE.claims(undefined, { execute: async () => "x" } as never)).toBe(false);
  });

  it("code mode claims agents and any executable host tool, but not provider tools", () => {
    expect(CODE_MODE_SURFACE.claims(subagentTool, {} as never)).toBe(true);
    expect(CODE_MODE_SURFACE.claims(undefined, { execute: async () => "x" } as never)).toBe(true);
    expect(CODE_MODE_SURFACE.claims(undefined, {} as never)).toBe(false);
  });
});
