import { describe, expect, it } from "vitest";

import { composeAgentModuleCandidates } from "#compiler/compose-agent-module-candidates.js";
import { prepareSourceComposition } from "#compiler/prepare-source-composition.js";

const candidate = (
  sourceId: string,
  layer: "application" | "extension-package" | "framework-default",
) => ({
  backing: { externalDependencies: [], kind: "filesystem" as const, sourcePath: `/${sourceId}` },
  layer,
  logicalPath: "tools/search.ts",
  nodeId: "root",
  owner:
    layer === "framework-default"
      ? ({ feature: "defaults", kind: "framework" } as const)
      : layer === "extension-package"
        ? ({ kind: "extension", namespace: "crm", packageName: "crm" } as const)
        : ({ kind: "application" } as const),
  sourceId,
});

describe("prepareSourceComposition", () => {
  it("reports losing candidates without duplicating active resource rows", () => {
    const composition = composeAgentModuleCandidates([
      candidate("framework", "framework-default"),
      candidate("extension", "extension-package"),
      candidate("application", "application"),
    ]);

    expect(prepareSourceComposition({ composition, disabledWinnerSourceIds: new Set() })).toEqual({
      disabled: [],
      shadowed: [
        expect.objectContaining({
          slot: "tools/search",
          source: expect.objectContaining({ sourceId: "framework" }),
        }),
        expect.objectContaining({
          slot: "tools/search",
          source: expect.objectContaining({ sourceId: "extension" }),
        }),
      ],
      sourceOwners: { application: { kind: "application" } },
    });
  });

  it("reports a selected disable sentinel and its effective target", () => {
    const composition = composeAgentModuleCandidates([
      candidate("framework", "framework-default"),
      candidate("disable", "application"),
    ]);

    expect(
      prepareSourceComposition({
        composition,
        disabledWinnerSourceIds: new Set(["disable"]),
      }).disabled,
    ).toEqual([
      expect.objectContaining({
        slot: "tools/search",
        source: expect.objectContaining({ sourceId: "disable" }),
        target: expect.objectContaining({ sourceId: "framework" }),
      }),
    ]);
  });
});
