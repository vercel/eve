import { describe, expect, it } from "vitest";

import { resolveBoardSettings, splitBoardText } from "#public/channels/board/boardChannel.js";

describe("resolveBoardSettings", () => {
  it.each([
    { name: "a watcher named worker", config: { watchers: { worker: { tail: "dev" } } } },
    { name: "a tail under the profile worker", config: { profile: "worker", tail: "dev" } },
  ])("reserves the worker watcher for task claims: $name", ({ config }) => {
    expect(() => resolveBoardSettings(config)).toThrow(/"worker" is reserved for task claims/u);
  });

  it("names task owners by principal ID, not actor ID", () => {
    expect(() =>
      resolveBoardSettings({
        worker: { channel: "work/", from: ["vercel:project:prj_planner:production+planner"] },
      }),
    ).toThrow(/by principal ID/u);
    expect(
      resolveBoardSettings({
        worker: { channel: "work/", from: ["vercel:project:prj_planner:production"] },
      }).worker?.from,
    ).toEqual(["vercel:project:prj_planner:production"]);
  });
});

describe("splitBoardText", () => {
  it("never splits a surrogate pair across messages", () => {
    const chunks = splitBoardText(`${"a".repeat(9)}😀b`, 10);
    expect(chunks).toEqual(["a".repeat(9), "😀b"]);
  });
});
