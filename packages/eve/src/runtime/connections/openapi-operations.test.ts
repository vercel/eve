import { expect, it } from "vitest";
import { uniqueName } from "#runtime/connections/openapi-operations.js";

it("keeps collision suffixes within the 64-character tool name limit", () => {
  const base = "a".repeat(64);
  const used = new Set([base, `${"a".repeat(62)}_2`]);
  const names = Array.from({ length: 9 }, () => uniqueName(base, used));
  expect(names[0]).toBe(`${"a".repeat(62)}_3`);
  expect(names.at(-1)).toBe(`${"a".repeat(61)}_11`);
  expect(names.every((name) => name.length <= 64)).toBe(true);
});
