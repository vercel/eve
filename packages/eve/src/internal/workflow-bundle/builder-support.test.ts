import { describe, expect, it } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import {
  createWorkflowDriverAliasPlugin,
  createWorkflowNodeBuiltinGuardPlugin,
} from "#internal/workflow-bundle/builder-support.js";

describe("createWorkflowNodeBuiltinGuardPlugin", () => {
  const plugin = createWorkflowNodeBuiltinGuardPlugin();

  function resolve(source: string, importer?: string): unknown {
    return (plugin.resolveId as (s: string, i?: string) => unknown)(source, importer);
  }

  it("throws on a prefixed node: builtin and names the importer", () => {
    expect(() => resolve("node:util", "/app/src/execution/x.ts")).toThrow(
      /Node\.js builtin "node:util".*imported by "\/app\/src\/execution\/x\.ts".*use step/s,
    );
  });

  it("throws on a bare builtin specifier", () => {
    expect(() => resolve("fs")).toThrow(/Node\.js builtin "fs"/);
  });

  it("passes through non-builtin specifiers", () => {
    expect(resolve("#internal/logging.js")).toBeUndefined();
    expect(resolve("./sibling.js")).toBeUndefined();
    expect(resolve("eve")).toBeUndefined();
  });

  it("omits the importer clause when the importer is unknown", () => {
    expect(() => resolve("node:crypto")).toThrow(/Node\.js builtin "node:crypto"\. Move/);
  });
});

describe("createWorkflowDriverAliasPlugin", () => {
  const plugin = createWorkflowDriverAliasPlugin(resolvePackageRoot());

  function resolve(source: string, importer?: string): unknown {
    return (plugin.resolveId as (s: string, i?: string) => unknown)(source, importer);
  }

  it.each(["eve/workflow", "eve/experimental/workflow", "workflow"])(
    "resolves %s to the body-side shim",
    (source) => {
      expect(resolve(source)).toEqual({ id: expect.stringMatching(/workflow-core-shim\.[jt]s$/u) });
    },
  );

  it.each(["eve/workflow/api", "eve/experimental/workflow/api", "workflow/api"])(
    "rejects %s inside a workflow body",
    (source) => {
      expect(() => resolve(source, "/app/flow.ts")).toThrow(
        /runtime API is not available inside a workflow body/u,
      );
    },
  );
});
