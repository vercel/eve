import { jsonSchema, type TextStreamPart, type ToolSet } from "ai";
import { expect, it } from "vitest";

import { emitStreamContent } from "#harness/emission.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";

// A call whose input isn't an object is introduced with its error. A tool that sets `label: false`
// stays out of activity on that path too, and publishes no input preview that would show it first.
it.each([
  { label: false as const, previews: 0, hidden: true },
  { label: undefined, previews: 1, hidden: undefined },
])("introduces an invalid call with label=$label", async ({ label, previews, hidden }) => {
  const events: SessionEvent[] = [];
  async function* stream() {
    yield* [
      { id: "call-react", toolName: "react", type: "tool-input-start" },
      { delta: "[1]", id: "call-react", type: "tool-input-delta" },
      { id: "call-react", type: "tool-input-end" },
      { input: "[1]", toolCallId: "call-react", toolName: "react", type: "tool-call" },
      { finishReason: "tool-calls", type: "finish-step" },
    ] as TextStreamPart<ToolSet>[];
  }

  await emitStreamContent(
    eachEvent(async (event) => {
      events.push(event);
    }),
    { runId: "run_0", sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
    stream(),
    {
      excludedActionToolNames: new Set(),
      sessionCall: () => undefined,
      tools: new Map([
        [
          "react",
          {
            description: "React to Alice's message with an emoji.",
            inputSchema: jsonSchema({ type: "object" }),
            label,
            name: "react",
          },
        ],
      ]),
    },
  );

  expect(events.filter((event) => event.type === "call.input")).toHaveLength(previews);
  const requested = events.find((event) => event.type === "call.requested");
  expect(requested?.data).toMatchObject({ inputError: { code: "INVALID_TOOL_INPUT" } });
  expect(requested?.type === "call.requested" && requested.data.capability.hidden).toBe(hidden);
});
