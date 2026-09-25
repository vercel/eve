import { describe, expect, it } from "vitest";
import { uniqueName } from "./openapi-operations.js";

describe("uniqueName", () => {
  it("returns the name unchanged when it is free", () => {
    const used = new Set<string>();
    expect(uniqueName("get_users", used)).toBe("get_users");
    expect(used.has("get_users")).toBe(true);
  });

  it("appends an increasing suffix on collisions", () => {
    const used = new Set<string>();
    expect(uniqueName("get_users", used)).toBe("get_users");
    expect(uniqueName("get_users", used)).toBe("get_users_2");
    expect(uniqueName("get_users", used)).toBe("get_users_3");
  });

  it("keeps a colliding 64-character name within the provider limit", () => {
    const base = "a".repeat(64);
    const used = new Set([base]);
    const result = uniqueName(base, used);
    expect(result).toHaveLength(64);
    expect(result).toBe(`${"a".repeat(62)}_2`);
    expect(result).not.toBe(base);
  });

  it("stays within the limit and unique across repeated long collisions", () => {
    const base = "b".repeat(63);
    const used = new Set([base]);
    const names = Array.from({ length: 10 }, () => uniqueName(base, used));
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(names[8]).toBe(`${"b".repeat(61)}_10`);
  });

  it("does not shorten names that have room for the suffix", () => {
    const base = "c".repeat(62);
    const used = new Set([base]);
    expect(uniqueName(base, used)).toBe(`${base}_2`);
  });
});
