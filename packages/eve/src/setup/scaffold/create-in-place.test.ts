import { describe, expect, test } from "vitest";

import { blockingCreateInPlaceEntries } from "./create-in-place.js";

describe("blockingCreateInPlaceEntries", () => {
  test("allows source-controlled runtime selectors needed before init", () => {
    expect(
      blockingCreateInPlaceEntries([
        "mise.toml",
        ".mise.toml",
        ".tool-versions",
        ".nvmrc",
        ".node-version",
      ]),
    ).toEqual([]);
  });

  test("blocks private configuration and scaffold conflicts", () => {
    const blocking = [
      "mise.local.toml",
      ".npmrc",
      ".gitignore",
      "package.json",
      "pnpm-workspace.yaml",
    ];

    expect(blockingCreateInPlaceEntries(blocking)).toEqual(blocking);
  });
});
