import { isDeepStrictEqual as nodeDeepEqual } from "node:util";
import { describe, expect, it } from "vitest";

import { isDeepStrictEqual } from "./deep-equal.web.ts";

const PAIRS: readonly (readonly [unknown, unknown])[] = [
  [1, 1],
  [1, "1"],
  [Number.NaN, Number.NaN],
  [0, -0],
  [null, undefined],
  [
    { a: 1, b: [1, 2] },
    { b: [1, 2], a: 1 },
  ],
  [{ a: 1 }, { a: 1, b: undefined }],
  [
    [1, 2],
    [1, 2, 3],
  ],
  [new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  [new Uint8Array([1, 2]), new Uint8Array([1, 3])],
  [new Uint8Array([1]), [1]],
  [new Map([[1, 2]]), new Map()],
  [new Map([[1, 2]]), new Map([[1, 2]])],
  [new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]])],
  [new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 2 }, "v"]])],
  [new Set([1, 2]), new Set([2, 1])],
  [new Set([1]), new Set()],
  [new Set([{ a: 1 }]), new Set([{ a: 1 }])],
  [new Date(1), new Date(1)],
  [new Date(1), new Date(2)],
  [new URL("https://a.example/x"), new URL("https://a.example/x")],
  [new URL("https://a.example/x"), new URL("https://a.example/y")],
  [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ],
  [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "ho" }] },
  ],
];

describe("the structural equality the browser build uses", () => {
  it("answers as node:util's isDeepStrictEqual does for the data eve compares", () => {
    for (const [a, b] of PAIRS) expect(isDeepStrictEqual(a, b)).toBe(nodeDeepEqual(a, b));
  });
});
