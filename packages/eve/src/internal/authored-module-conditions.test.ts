import { describe, expect, it } from "vitest";

import { authoredModuleConditions } from "./authored-module-conditions.js";

describe("authoredModuleConditions", () => {
  it("leaves ordinary builds on eve's source condition", () => {
    expect(authoredModuleConditions(["--enable-source-maps"], "")).toEqual(["eve-source"]);
  });

  it.each([
    ["--conditions=react-server"],
    ["--conditions", "react-server"],
    ["-C", "react-server"],
  ])("preserves command-line conditions %j", (...args) => {
    expect(authoredModuleConditions(args, "")).toEqual(["eve-source", "react-server"]);
  });

  it("reads quoted NODE_OPTIONS and combines repeated conditions", () => {
    expect(
      authoredModuleConditions(
        ["--conditions=react-server", "-C", "custom"],
        '--conditions="react-server" --require "./path with spaces/preload.js" -C "custom condition"',
      ),
    ).toEqual(["eve-source", "react-server", "custom condition", "custom"]);
  });

  it("preserves escaped quotes in NODE_OPTIONS", () => {
    expect(authoredModuleConditions([], '--conditions="custom\\"condition"')).toEqual([
      "eve-source",
      'custom"condition',
    ]);
  });

  it("leaves standard condition selection to each bundler import edge", () => {
    expect(
      authoredModuleConditions(
        [
          "--conditions=import",
          "--conditions=require",
          "--conditions=node",
          "--conditions=default",
          "--conditions=browser",
        ],
        "",
      ),
    ).toEqual(["eve-source"]);
  });
});
