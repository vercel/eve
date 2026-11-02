import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import type { ContextAccessor } from "#context/key.js";
import { AgentSessionRuntimeOverridesKey, DynamicSubagentAgentConfigKey } from "#context/keys.js";
import { chooseModel, currentModel, parentModel } from "./model.js";

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

describe("the model a session runs", () => {
  const agentDynamic = { reference: { id: "openai/gpt-5.4" } };
  const subagentConfig = { id: "anthropic/claude-sonnet-4.6" };
  const callerOverride = { id: "google/gemini-3-pro" };

  async function chosen(given: {
    readonly subagentConfig?: boolean;
    readonly callerOverride?: boolean;
  }): Promise<string | undefined> {
    const ctx = new ContextContainer();
    if (given.subagentConfig === true) {
      ctx.set(DynamicSubagentAgentConfigKey, { description: "Reviews.", model: subagentConfig });
    }
    if (given.callerOverride === true) {
      ctx.set(AgentSessionRuntimeOverridesKey, { model: callerOverride });
    }
    const parent = parentModel.contribute({
      container: ctx,
      history: undefined,
      keep: async () => undefined,
      signal: new AbortController().signal,
    });
    return (await chooseModel([{ model: () => agentDynamic }, parent], ctx))?.reference.id;
  }

  it.each([
    ["the agent's own dynamic model, given nothing", {}, agentDynamic.reference.id],
    [
      "a dynamic subagent's config over the agent's own",
      { subagentConfig: true },
      subagentConfig.id,
    ],
    [
      "a caller's override over a subagent's config",
      { callerOverride: true, subagentConfig: true },
      callerOverride.id,
    ],
  ])("runs %s", async (_name, given, expected) => {
    expect(await chosen(given)).toBe(expected);
  });
});
