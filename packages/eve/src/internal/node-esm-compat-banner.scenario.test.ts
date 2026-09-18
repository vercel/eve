import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";

describe("Node ESM compatibility banner bundling", () => {
  it.each(["using", "await using"])(
    "loads a chunk with %s compatibility bindings",
    async (declaration) => {
      const source = `
${declaration} __filename = { value: "filename", [Symbol.dispose]() {} };
${declaration} __dirname = { value: "dirname", [Symbol.dispose]() {} };
${declaration} require = { value: "require", [Symbol.dispose]() {} };
export const value = [__filename.value, __dirname.value, require.value];`;
      const chunk = await buildSingleRolldownChunk("resource compatibility bindings", {
        input: "virtual:resources",
        platform: "node",
        plugins: [
          {
            name: "resource-fixture",
            resolveId: (id: string) => (id === "virtual:resources" ? id : undefined),
            load: () => source,
            renderChunk: () => source,
          },
          createNodeEsmCompatBannerPlugin({ includeRequire: true }),
        ],
        output: { format: "esm" },
      });

      const namespace = await import(
        `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
      );
      expect(namespace.value).toEqual(["filename", "dirname", "require"]);
    },
  );

  it("loads a chunk with comma-separated compatibility bindings", async () => {
    const source = `const logs = [], require = () => "required", __filename = "/agent/index.mjs", __dirname = "/agent";
export const value = [logs, require(), __filename, __dirname];`;
    const chunk = await buildSingleRolldownChunk("compatibility bindings", {
      input: "virtual:compatibility",
      platform: "node",
      plugins: [
        {
          name: "compatibility-fixture",
          resolveId: (id: string) => (id === "virtual:compatibility" ? id : undefined),
          load: () => source,
          renderChunk: () => source,
        },
        createNodeEsmCompatBannerPlugin({ includeRequire: true }),
      ],
      output: { format: "esm" },
    });

    const namespace = await import(
      `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
    );
    expect(namespace.value).toEqual([[], "required", "/agent/index.mjs", "/agent"]);
  });
});
