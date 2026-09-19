import assert from "node:assert/strict";
import { test } from "node:test";
import agent from "../agent/agent.ts";

const marker = "MIXED-PARK-COMPLETE-7K2M";
const request = { role: "user", content: [{ type: "text", text: `Return ${marker}.` }] };
const results = {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "collision-gate-call",
      toolName: "collision-gate",
      output: { type: "json", value: { marker } },
    },
    {
      type: "tool-result",
      toolCallId: "collision-child-call",
      toolName: "collision-child",
      output: {
        type: "json",
        value: { agentId: "ag_child", status: "working", taskId: "task_child" },
      },
    },
  ],
};

async function reply(...messages) {
  const result = await agent.model.doGenerate({ prompt: [request, results, ...messages] });
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

test("approval plus a working receipt does not finish the mixed approval case", async () => {
  assert.equal(await reply(), "The gate was approved; the child is still working.");
});

test("launch reporting guidance does not turn the receipt into a result", async () => {
  const message = {
    role: "user",
    content: [{ type: "text", text: "Background task reporting: launch acknowledgement" }],
  };
  assert.equal((await reply(message)).includes(marker), false);
});

test("the final marker follows the child's completed result notification", async () => {
  const message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Background task task_child (collision-child) is completed.\n\nResult:\n${marker}`,
      },
    ],
  };
  assert.equal(await reply(message), marker);
});
