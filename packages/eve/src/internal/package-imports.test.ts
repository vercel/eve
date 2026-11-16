import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { resolveEveDistImport } from "./package-imports.js";

const root = "file:///app/node_modules/eve/dist/src/";
const parent = `${root}cli/run.js`;

describe("resolveEveDistImport", () => {
  it("mirrors the default targets of eve's package imports", () => {
    expect(packageJson.imports).toEqual({
      "#compiled/*": { "eve-source": "./.generated/compiled/*", default: "./dist/src/compiled/*" },
      "#*.js": { "eve-source": "./src/*.ts", default: "./dist/src/*.js" },
    });
  });

  it.each([
    ["#compiled/zod/index.js", `${root}compiled/zod/index.js`],
    ["#compiled/@vercel/oidc/index.js", `${root}compiled/@vercel/oidc/index.js`],
    ["#internal/logging.js", `${root}internal/logging.js`],
    ["#cli/dev/tui/tui.js", `${root}cli/dev/tui/tui.js`],
    ["#internal/node_modulesx.js", `${root}internal/node_modulesx.js`],
    ["./output.js", `${root}cli/output.js`],
    ["../internal/logging.js", `${root}internal/logging.js`],
  ])("maps %s", (specifier, expected) => {
    expect(resolveEveDistImport(specifier, parent, ["node", "import"], root)).toBe(expected);
  });

  it.each([
    ["a module outside eve's dist", "#internal/logging.js", "file:///app/agent/agent.ts", []],
    ["the eve-source condition", "#internal/logging.js", parent, ["eve-source", "import"]],
    ["a specifier no pattern matches", "#internal/logging", parent, []],
    ["a parent-directory segment", "#internal/../x.js", parent, []],
    ["a node_modules segment", "#compiled/node_modules/x.js", parent, []],
    ["an encoded character", "#internal/%2e%2e/x.js", parent, []],
    ["a bare specifier", "zod", parent, []],
    [
      "a dependency inlined under dist",
      "#internal/logging.js",
      `${root}node_modules/dep/index.js`,
      [],
    ],
    ["a relative import leaving dist", "../../package.json.js", parent, []],
    ["a relative import without .js", "./data.json", parent, []],
  ])("leaves %s to Node", (_case, specifier, parentUrl, conditions) => {
    expect(resolveEveDistImport(specifier, parentUrl, conditions, root)).toBeUndefined();
  });
});
