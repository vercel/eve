import { expect, it } from "vitest";
import { normalizeChannelCors } from "#channel/cors.js";

it.each(["https://client.example", ["https://client.example"]])(
  "normalizes a declared origin to the compiled origin list: %j",
  (origin) => {
    expect(normalizeChannelCors({ origin })).toEqual({ origin: ["https://client.example"] });
  },
);

it("rejects an empty single origin rather than compiling an unusable policy", () => {
  expect(() => normalizeChannelCors({ origin: "" })).toThrow(/non-empty origin/);
});
