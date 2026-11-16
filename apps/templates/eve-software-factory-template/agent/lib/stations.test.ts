import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("eve/tools", {
  namedExports: { defineWorkflowTool: (config: unknown) => config },
});
const { default: tool } = (await import("../tools/run_analyst.js")) as any;
const { default: rootAgent } = await import("../agent.js");

test("factory usage policy caps output and uncached input without charging cached input twice", () => {
  const limit = rootAgent.limits?.sessionUsage as (context: any) => boolean;
  const window = { cacheReadTokens: 0, inputTokens: 0, outputTokens: 99_999 };
  assert.equal(limit({ window }), false);
  assert.equal(limit({ window: { ...window, outputTokens: 100_000 } }), true);
  assert.equal(limit({ window: { ...window, inputTokens: 40_000_000 } }), true);
  assert.equal(
    limit({
      window: { ...window, cacheReadTokens: 1, inputTokens: 40_000_000 },
    }),
    false
  );
});

const context = (result: unknown) => ({
  agent: () => ({
    send: () => Promise.resolve({ result: () => Promise.resolve(result) }),
  }),
});

test("station failures and empty completions surface as tool errors instead of silently continuing", async () => {
  await Promise.all(
    [
      { error: { message: "Structured output failed" }, status: "failed" },
      { status: "cancelled" },
      { status: "completed" },
      { data: null, status: "completed" },
    ].map((result) =>
      assert.rejects(
        tool.execute({ message: "Plan the work" }, context(result))
      )
    )
  );
  const data = { acceptance_criteria: ["Email is sent once"] };
  assert.deepEqual(
    await tool.execute(
      { message: "Plan the work" },
      context({ data, status: "completed" })
    ),
    data
  );
});
