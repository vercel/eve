import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("#runtime-env/async-storage.js", () => import("#runtime-env/async-storage.web.js"));

const CONTEXT_STORAGE = Symbol.for("eve.context-storage");
vi.hoisted(() => Reflect.deleteProperty(globalThis, Symbol.for("eve.context-storage")));
afterAll(() => Reflect.deleteProperty(globalThis, CONTEXT_STORAGE));

const { ContextContainer, contextStorage } = await import("#context/container.js");
const { ScopeOrderError } = await import("#context/scope-storage.js");
const { startEach, toolConcurrency } = await import("#harness/tool-concurrency.js");

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("without AsyncLocalStorage", () => {
  it("keeps eve's context in the settling storage", () => {
    expect(contextStorage.kind).toBe("settling");
  });

  it("runs a step's tool calls one at a time, in order, each after the last settles", async () => {
    expect(toolConcurrency()).toBe("sequential");
    const order: string[] = [];
    const runs = startEach(["a", "b", "c"], async (item) => {
      order.push(`start ${item}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(`end ${item}`);
      if (item === "b") throw new Error("b failed");
      return item;
    });
    const settled = await Promise.allSettled(runs);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("gives each tool call its own context across its awaits", async () => {
    const contexts = [new ContextContainer(), new ContextContainer()];
    const seen = await Promise.all(
      startEach(contexts, (context) =>
        contextStorage.run(context, async () => {
          const before = contextStorage.getStore();
          await new Promise((resolve) => setTimeout(resolve, 1));
          return [before, contextStorage.getStore()];
        }),
      ),
    );
    expect(seen).toEqual([
      [contexts[0], contexts[0]],
      [contexts[1], contexts[1]],
    ]);
    expect(contextStorage.getStore()).toBeUndefined();
  });

  it("refuses every read once two scopes overlap and settle out of order", async () => {
    const first = deferred();
    const second = deferred();
    const outer = contextStorage.run(new ContextContainer(), () => first.promise);
    const inner = contextStorage.run(new ContextContainer(), () => second.promise);
    first.resolve();
    await outer;
    expect(() => contextStorage.getStore()).toThrow(ScopeOrderError);
    second.resolve();
    await inner;
    expect(() => contextStorage.getStore()).toThrow(ScopeOrderError);
  });
});
