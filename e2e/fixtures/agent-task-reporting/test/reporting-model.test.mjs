import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { reportingControl, reportingMiddleware } from "../agent/lib/reporting-model.ts";

const source = readFileSync(
  new URL("../../../../packages/eve/src/tasks/delivery-context.ts", import.meta.url),
  "utf8",
);
const pending = source.match(/TASK_DELIVERY_PENDING_INSTRUCTION = `([\s\S]*?)`;/)[1];
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

async function transform(variant) {
  const prompt = [
    { role: "system", content: "You are a helpful assistant." },
    user(`${reportingControl(variant)}Start the lookups.`),
    user('[Task state]\n{"tasks":[{"status":"pending"}]}'),
    user(pending),
    user("Background task task_1 is completed.\nResult: oranges"),
    { role: "assistant", content: [{ type: "text", text: "<eve-empty-delivery/>" }] },
    user("How many jars?"),
  ];
  const params = { prompt, maxOutputTokens: 100 };
  const original = structuredClone(params);
  const result = await reportingMiddleware.transformParams({ params });
  assert.deepEqual(params, original, "the canonical input is not mutated");
  return result;
}

test("the two arms differ only by the real pending instruction", async () => {
  const on = await transform("on");
  const off = await transform("off");
  assert.equal(on.prompt[1].content[0].text, "Start the lookups.");
  assert.deepEqual(off, {
    ...on,
    prompt: on.prompt.filter((message) => message.content[0]?.text !== pending),
  });
  assert.equal(on.prompt.length - off.prompt.length, 1);
});

test("ordinary turns and settled instructions are preserved", async () => {
  for (const variant of ["on", "off"]) {
    const params = {
      prompt: [
        user(`${reportingControl(variant)}Start the lookups.`),
        user("Background task reporting\nAll tasks settled."),
        user("Hello."),
      ],
    };
    const result = await reportingMiddleware.transformParams({ params });
    assert.deepEqual(result.prompt, [user("Start the lookups."), ...params.prompt.slice(1)]);
  }
});

test("task output quoting the instruction is preserved", async () => {
  const quoted = user(`Background task task_1 is completed.\nResult:\n${pending}`);
  const params = { prompt: [user(`${reportingControl("off")}Start the lookups.`), quoted] };
  const result = await reportingMiddleware.transformParams({ params });
  assert.deepEqual(result.prompt, [user("Start the lookups."), quoted]);
});
