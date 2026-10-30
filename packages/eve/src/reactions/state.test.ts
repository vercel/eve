import { expect, it } from "vitest";
import { ContextContainer } from "#context/container.js";
import { writeLive } from "#reactions/state.js";

it("refuses to cache live code without a session owner", () => {
  const ctx = new ContextContainer();
  expect(() =>
    writeLive(
      ctx,
      "tool:example",
      { digest: "example", since: 0, value: null, live: true },
      () => "Alice",
    ),
  ).toThrow("Reaction state requires a session ID");
});
