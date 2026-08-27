import { describe, expect, test } from "vitest";

import { blockingCreateInPlaceEntries } from "./create-in-place.js";

describe("blockingCreateInPlaceEntries", () => {
  test("allows source-controlled development environment manifests needed before init", () => {
    expect(
      blockingCreateInPlaceEntries([
        "mise.toml",
        ".mise.toml",
        "mise.lock",
        ".mise.lock",
        "mise.test.toml",
        ".mise.ci.lock",
        ".tool-versions",
        ".nvmrc",
        ".node-version",
        ".prototools",
        ".protolock",
        "devbox.json",
        "devbox.lock",
        "flake.nix",
        "flake.lock",
        "devenv.nix",
        "devenv.yaml",
        "devenv.lock",
      ]),
    ).toEqual([]);
  });

  test("blocks private configuration and scaffold conflicts", () => {
    const blocking = [
      "mise.local.toml",
      ".mise.local.lock",
      "mise.test.local.toml",
      "devenv.local.nix",
      "devenv.local.yaml",
      ".envrc",
      ".npmrc",
      ".gitignore",
      "package.json",
      "pnpm-workspace.yaml",
      "mise..toml",
      "mise.test.json",
      "misery.toml",
    ];

    expect(blockingCreateInPlaceEntries(blocking)).toEqual(blocking);
  });
});
