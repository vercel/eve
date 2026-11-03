import { describe, expect, it } from "vitest";

import { decideModel, draftOf } from "./combine.js";
import type { Contribution, Section } from "./definition.js";

function section(text: string): Section {
  return { key: text, order: 0, part: "base", text };
}

describe("draftOf", () => {
  it("collects in definition order, then lets each arrange what those before it left", async () => {
    const made: string[] = [];
    const adds = (text: string): Contribution => ({
      system: () => {
        made.push(text);
        return [section(text)];
      },
    });
    const draft = draftOf([
      adds("instructions"),
      {
        arrange: (inner) => ({
          system: async () => [...(await inner.system()), ...(await inner.system())],
        }),
      },
      adds("workspace"),
    ]);

    expect((await draft.system()).map(({ text }) => text)).toEqual([
      "instructions",
      "workspace",
      "instructions",
      "workspace",
    ]);
    // Each part is made once, however often an arrangement reads it.
    expect(made).toEqual(["instructions", "workspace"]);
  });

  it("makes nothing an arrangement replaces without reading", async () => {
    const made: string[] = [];
    const draft = draftOf([
      { system: () => (made.push("instructions"), [section("instructions")]) },
      { arrange: () => ({ system: async () => [section("replaced")] }) },
    ]);

    expect((await draft.system()).map(({ text }) => text)).toEqual(["replaced"]);
    expect(made).toEqual([]);
  });
});

describe("decideModel", () => {
  it("takes the latest answer, and asks earlier definitions only when it passes", async () => {
    const asked: string[] = [];
    const answers = (name: string, answer: string | undefined): Contribution => ({
      model: () => (asked.push(name), answer),
    });

    expect(await decideModel([answers("agent", "a"), answers("harness", "h")])).toBe("h");
    expect(asked).toEqual(["harness"]);
    expect(await decideModel([answers("agent", "a"), answers("harness", undefined)])).toBe("a");
  });
});
