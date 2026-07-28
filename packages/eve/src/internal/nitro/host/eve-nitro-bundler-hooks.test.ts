import type { Nitro } from "nitro/types";
import { describe, expect, it, vi } from "vitest";

import { externalizeDevelopmentWorkflowBundle } from "#internal/nitro/host/eve-nitro-bundler-hooks.js";
import type { EveNitroContribution } from "#internal/nitro/host/eve-nitro-contribution.js";

type ExternalFunction = (
  id: string,
  importer: string | undefined,
  isResolved: boolean,
) => boolean | null | undefined;
type ExternalOption = string | RegExp | Array<string | RegExp> | ExternalFunction;

const workflowBuildDir = "/tmp/weather-agent/.eve/workflow";
const workflowBundlePath = `${workflowBuildDir}/workflows.mjs`;

function configureExternal(existingExternal?: ExternalOption): ExternalFunction {
  let rollupBefore: ((_nitro: Nitro, config: { external?: ExternalOption }) => void) | undefined;
  const nitro = Object.assign({} as Nitro, {
    hooks: {
      hook: vi.fn((name: string, handler: typeof rollupBefore) => {
        expect(name).toBe("rollup:before");
        rollupBefore = handler;
      }),
    },
  });
  const contribution = {
    preparedHost: { workflowBuildDir },
  } as EveNitroContribution<"development">;
  const config: { external?: ExternalOption } = { external: existingExternal };

  externalizeDevelopmentWorkflowBundle(nitro, contribution);
  rollupBefore?.(nitro, config);

  if (typeof config.external !== "function") {
    throw new TypeError("Expected eve to install an external matcher.");
  }
  return config.external;
}

describe("externalizeDevelopmentWorkflowBundle", () => {
  it("externalizes eve's Workflow bundle and delegates other modules to a host function", () => {
    const hostExternal = vi.fn<ExternalFunction>((id) => {
      if (id === "host-function-external") return true;
      if (id === "host-function-internal") return false;
      if (id === "host-function-null") return null;
      return undefined;
    });
    const external = configureExternal(hostExternal);

    expect(external(workflowBundlePath, "/tmp/importer.mjs", true)).toBe(true);
    expect(hostExternal).not.toHaveBeenCalled();

    expect(external("host-function-external", "/tmp/importer.mjs", true)).toBe(true);
    expect(hostExternal).toHaveBeenCalledWith("host-function-external", "/tmp/importer.mjs", true);
    expect(external("host-function-internal", undefined, false)).toBe(false);
    expect(external("host-function-null", undefined, false)).toBeNull();
    expect(external("unmatched", undefined, false)).toBeUndefined();
  });

  it.each<{
    existingExternal: ExternalOption;
    matchingIds: string[];
    name: string;
    nonMatchingIds?: string[];
  }>([
    {
      existingExternal: "host-string-external",
      matchingIds: ["host-string-external"],
      name: "a string",
      nonMatchingIds: ["host-string-external/subpath"],
    },
    {
      existingExternal: ["host-array-external"],
      matchingIds: ["host-array-external"],
      name: "a string array",
      nonMatchingIds: ["host-array-external/subpath"],
    },
    {
      existingExternal: /^host-regexp-external(?:\/|$)/,
      matchingIds: ["host-regexp-external", "host-regexp-external/subpath"],
      name: "a RegExp",
    },
    {
      existingExternal: ["host-mixed-exact", /^host-mixed-regexp(?:\/|$)/],
      matchingIds: ["host-mixed-exact", "host-mixed-regexp", "host-mixed-regexp/subpath"],
      name: "mixed string and RegExp entries",
      nonMatchingIds: ["host-mixed-exact/subpath"],
    },
  ])(
    "preserves $name host external option",
    ({ existingExternal, matchingIds, nonMatchingIds }) => {
      const external = configureExternal(existingExternal);

      expect(external(workflowBundlePath, undefined, false)).toBe(true);
      for (const matchingId of matchingIds) {
        expect(external(matchingId, undefined, false)).toBe(true);
      }
      for (const nonMatchingId of ["host-non-match", ...(nonMatchingIds ?? [])]) {
        expect(external(nonMatchingId, undefined, false)).toBe(false);
      }
    },
  );
});
