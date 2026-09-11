import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CROSS_TURN_SCENARIO,
  LIFECYCLE_SCENARIO,
  lifecycleModel,
} from "../agent/lib/lifecycle-model.ts";

const key = "00000000-0000-4000-8000-000000000001";
const instruction =
  "Background task reporting: launch acknowledgement\nAcknowledge the accepted work.";
const taskState = '[Task state]\n{"tasks":[{"taskId":"task_a","status":"pending"}]}';

function request(userMessages, markers = []) {
  return {
    userMessages,
    messages: userMessages.map((text) => ({ role: "user", text })),
    toolResults: markers.map((marker) => ({
      id: `lifecycle-${marker}`,
      name: "lifecycle_task",
      output: { status: "working", taskId: `task_${marker.toLowerCase()}` },
    })),
  };
}

for (const [scenario, markers] of [
  [CROSS_TURN_SCENARIO, ["A"]],
  [LIFECYCLE_SCENARIO, ["A", "B"]],
]) {
  test(`${scenario} acknowledges receipts behind framework instructions`, () => {
    const messages = [`${scenario} ${key}`, taskState, instruction];
    assert.deepEqual(lifecycleModel(request(messages, markers)), {
      text: `LAUNCHED:${markers.join(",")}`,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
}

test("second-turn receipts are acknowledged without a premature report", () => {
  const messages = [
    `${CROSS_TURN_SCENARIO} ${key}`,
    taskState,
    instruction,
    "Alice now launches the second piece of work.",
    taskState,
    instruction,
  ];
  assert.equal(lifecycleModel(request(messages, ["A", "B"])).text, "LAUNCHED:B");
});

test("reports every actual completion, not framework reporting instructions", () => {
  const a = "Background task task_a (lifecycle_task) is completed.\n\nResult:\nLIFECYCLE:A";
  const b = "Background task task_b (lifecycle_task) is completed.\n\nResult:\nLIFECYCLE:B";
  const messages = [`${LIFECYCLE_SCENARIO} ${key}`, instruction, a, b, taskState, instruction];
  const response = lifecycleModel(request(messages, ["A", "B"]));
  assert.deepEqual(JSON.parse(response.text), {
    report: "LIFECYCLE-REPORT",
    notifications: [a, b],
  });
});

test("does not implement a model-side barrier that could hide a partial runtime delivery", () => {
  const a = "Background task task_a (lifecycle_task) is completed.\n\nResult:\nLIFECYCLE:A";
  const response = lifecycleModel(
    request([`${CROSS_TURN_SCENARIO} ${key}`, a, instruction], ["A", "B"]),
  );
  assert.deepEqual(JSON.parse(response.text).notifications, [a]);
});

test("continues to answer ordinary user messages after a completed cohort", () => {
  const messages = [
    `${LIFECYCLE_SCENARIO} ${key}`,
    "Background task task_a (lifecycle_task) is completed.\n\nResult:\nLIFECYCLE:A",
    "Alice confirms that all completion deliveries have been observed.",
  ];
  assert.equal(lifecycleModel(request(messages, ["A", "B"])).text, "DRAIN-ACK");
});
