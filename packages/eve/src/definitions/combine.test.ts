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

  it("evaluates async system contributions concurrently while preserving definition order", async () => {
    const started: string[] = [];
    const gate = Promise.withResolvers<void>();
    const draft = draftOf([
      {
        system: async () => {
          started.push("first");
          await gate.promise;
          return [section("first")];
        },
      },
      {
        system: async () => {
          started.push("second");
          gate.resolve();
          return [section("second")];
        },
      },
    ]);

    expect((await draft.system()).map(({ text }) => text)).toEqual(["first", "second"]);
    expect(started).toEqual(["first", "second"]);
  });

  it("waits for sibling resolvers to settle and throws the first failure in definition order", async () => {
    const first = Promise.withResolvers<Section[]>();
    const second = Promise.withResolvers<Section[]>();
    let thirdFinished = false;
    const thirdGate = Promise.withResolvers<void>();
    const draft = draftOf([
      { system: () => first.promise },
      { system: () => second.promise },
      {
        system: async () => {
          await thirdGate.promise;
          thirdFinished = true;
          return [section("third")];
        },
      },
    ]);

    const pending = draft.system();
    let settledEarly = false;
    void pending.catch(() => {
      settledEarly = true;
    });
    second.reject(new Error("second failed first in time"));
    first.reject(new Error("first failed in definition order"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settledEarly).toBe(false);

    thirdGate.resolve();
    await expect(pending).rejects.toThrow("first failed in definition order");
    expect(thirdFinished).toBe(true);
  });
});

describe("decideModel", () => {
  it("takes the latest answer, and asks earlier definitions only when it passes", async () => {
    const asked: string[] = [];
    const answers = (name: string, id: string | undefined): Contribution => ({
      model: () => (asked.push(name), id === undefined ? undefined : { reference: { id } }),
    });

    expect(await decideModel([answers("agent", "a"), answers("harness", "h")])).toEqual({
      reference: { id: "h" },
    });
    expect(asked).toEqual(["harness"]);
    expect(await decideModel([answers("agent", "a"), answers("harness", undefined)])).toEqual({
      reference: { id: "a" },
    });
  });
});
