import { describe, expect, it } from "vitest";

import {
  compiledInstrumentationPlanActivatesInMode,
  isCompiledInstrumentationActivationActive,
} from "#compiler/instrumentation-plan-activation.js";
import type { CompiledInstrumentationPlan } from "#compiler/manifest.js";

const SOURCE = {
  logicalPath: "instrumentation.ts",
  sourceId: "instrumentation:root",
  sourceKind: "module",
} as const;

describe("compiled instrumentation activation", () => {
  it.each([
    ["always", "development", true],
    ["always", "production", true],
    ["development", "development", true],
    ["development", "production", false],
    ["production", "development", false],
    ["production", "production", true],
  ] as const)("evaluates %s activation in %s mode", (activation, mode, expected) => {
    expect(isCompiledInstrumentationActivationActive(activation, mode)).toBe(expected);
  });

  it("detects whether any entry in a compiled plan activates for the mode", () => {
    const plans: readonly [CompiledInstrumentationPlan, boolean, boolean][] = [
      [{ kind: "none" }, false, false],
      [
        {
          entry: {
            activation: "development",
            implementation: "local-tracing",
            source: SOURCE,
          },
          kind: "file",
        },
        true,
        false,
      ],
      [
        {
          entries: [
            {
              activation: "development",
              implementation: "provider",
              slot: "local",
              source: SOURCE,
            },
            {
              activation: "production",
              implementation: "provider",
              slot: "agent-runs",
              source: SOURCE,
            },
          ],
          kind: "providers",
        },
        true,
        true,
      ],
      [
        {
          entries: [
            {
              activation: "development",
              implementation: "provider",
              slot: "local",
              source: SOURCE,
            },
          ],
          kind: "providers",
        },
        true,
        false,
      ],
      [
        {
          entries: [
            {
              activation: "production",
              implementation: "provider",
              slot: "agent-runs",
              source: SOURCE,
            },
          ],
          kind: "providers",
        },
        false,
        true,
      ],
    ];

    for (const [plan, development, production] of plans) {
      expect(compiledInstrumentationPlanActivatesInMode(plan, "development")).toBe(development);
      expect(compiledInstrumentationPlanActivatesInMode(plan, "production")).toBe(production);
    }
  });
});
