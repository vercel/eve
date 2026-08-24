import { describe, expect, it } from "vitest";

import { createFrameworkSourceRevisionPlugin } from "#framework-sources/revision-plugin.js";
import {
  createEveRuntimeSourceRevision,
  EVE_RUNTIME_SOURCE_REVISION_TOKEN,
} from "#framework-sources/revision.js";

describe("framework source revision", () => {
  it("changes for same-path executable source changes", () => {
    const first = createEveRuntimeSourceRevision([
      { content: 'export const execute = () => "first";\n', path: "framework-sources/tool.ts" },
    ]);
    const second = createEveRuntimeSourceRevision([
      { content: 'export const execute = () => "second";\n', path: "framework-sources/tool.ts" },
    ]);

    expect(second).not.toBe(first);
  });

  it("rejects source changes after bundle preflight", () => {
    let revision = "eve@0.0.0:first";
    const plugin = createFrameworkSourceRevisionPlugin({
      expectedRevision: revision,
      resolveRevision: () => revision,
    }) as {
      readonly buildEnd: () => void;
      readonly buildStart: () => void;
    };

    plugin.buildStart();
    revision = "eve@0.0.0:second";

    expect(() => plugin.buildEnd()).toThrow("Framework source revision changed");
  });

  it("stamps the runtime revision token before emitted code can execute", () => {
    const plugin = createFrameworkSourceRevisionPlugin() as {
      readonly transform: (code: string) => string | undefined;
    };
    const transformed = plugin.transform(
      `export const revision = ${JSON.stringify(EVE_RUNTIME_SOURCE_REVISION_TOKEN)};`,
    );

    expect(transformed).not.toContain(EVE_RUNTIME_SOURCE_REVISION_TOKEN);
  });

  it("stamps the compiler-selected package version into application bundles", () => {
    const revision = "eve@9.8.7:runtime-content";
    const plugin = createFrameworkSourceRevisionPlugin({
      expectedRevision: revision,
      resolveRevision: () => revision,
    }) as {
      readonly transform: (code: string) => string | undefined;
    };
    const packageVersionToken = ["__EVE", "PACKAGE_VERSION__"].join("_");
    const transformed = plugin.transform(
      `export const version = ${JSON.stringify(packageVersionToken)};`,
    );

    expect(transformed).toContain('"9.8.7"');
    expect(transformed).not.toContain(packageVersionToken);
  });
});
