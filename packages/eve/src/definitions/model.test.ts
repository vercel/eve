import { expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import type { ContextAccessor } from "#context/key.js";
import { chooseModel, currentModel } from "./model.js";

it("records the chosen model through a writable context without requiring class identity", async () => {
  const storage = new ContextContainer();
  const ctx: ContextAccessor = {
    ensure: storage.ensure.bind(storage),
    get: storage.get.bind(storage),
    has: storage.has.bind(storage),
    require: storage.require.bind(storage),
    set: storage.set.bind(storage),
  };
  const reference = { id: "openai/gpt-5.4" };

  await chooseModel([{ model: { reference } }], ctx);

  expect(currentModel(ctx)).toEqual(reference);
});
