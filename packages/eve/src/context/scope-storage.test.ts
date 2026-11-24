import { describe, expect, it } from "vitest";

import { ScopeOrderError, createScopeStorage, settlingScopeStorage } from "./scope-storage.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("scope storage", () => {
  it("is AsyncLocalStorage in Node", () => {
    expect(createScopeStorage("test").kind).toBe("async-local-storage");
  });

  describe("without AsyncLocalStorage", () => {
    it("keeps a scope across its callback's awaits, and restores the previous one after", async () => {
      const storage = settlingScopeStorage<string>("test");
      const seen: (string | undefined)[] = [];
      await storage.run("outer", async () => {
        seen.push(storage.getStore());
        await Promise.resolve();
        await storage.run("inner", async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          seen.push(storage.getStore());
        });
        seen.push(storage.getStore());
      });
      seen.push(storage.getStore());
      expect(seen).toEqual(["outer", "inner", "outer", undefined]);
    });

    it("ends a scope whose callback returns or throws synchronously", () => {
      const storage = settlingScopeStorage<string>("test");
      expect(storage.run("a", () => storage.getStore())).toBe("a");
      expect(() =>
        storage.run("b", () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(storage.getStore()).toBeUndefined();
    });

    it("ends a scope whose callback rejects", async () => {
      const storage = settlingScopeStorage<string>("test");
      await expect(storage.run("a", async () => Promise.reject(new Error("no")))).rejects.toThrow(
        "no",
      );
      expect(storage.getStore()).toBeUndefined();
    });

    it("refuses every read once scopes settle out of order", async () => {
      const storage = settlingScopeStorage<string>("test");
      const first = deferred();
      const second = deferred();
      const a = storage.run("a", () => first.promise);
      const b = storage.run("b", () => second.promise);
      first.resolve();
      await a;
      expect(() => storage.getStore()).toThrow(ScopeOrderError);
      second.resolve();
      await b;
      expect(() => storage.getStore()).toThrow(ScopeOrderError);
    });
  });
});
