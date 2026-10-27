import { describe, expect, it } from "vitest";

import { linearInteractionSignal, renderLinearInteractions } from "#public/channels/linear/hitl.js";
import type { Interaction } from "#channel/interaction-prompts.js";

function makeRequest(
  overrides: Partial<Interaction["request"]> &
    Partial<Pick<Interaction, "interactionId" | "call">> = {},
): Interaction {
  const {
    interactionId = "call_1",
    call = { callId: "call_1", name: "ask_question", input: {} },
    ...request
  } = overrides;
  return {
    interactionId,
    call,
    status: "open",
    turnId: "turn_0",
    stepIndex: 0,
    request: { prompt: "Approve deployment?", kind: "question", ...request },
  };
}

describe("Linear HITL helpers", () => {
  it("renders only user-visible input request text", () => {
    const rendered = renderLinearInteractions([
      makeRequest({
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel", description: "Stop the deployment" },
        ],
      }),
    ]);

    expect(rendered).toContain("Approve deployment?");
    expect(rendered).toContain("1. Approve");
    expect(rendered).toContain("2. Cancel - Stop the deployment");
    expect(rendered).not.toContain("eve-input");
    expect(rendered).not.toContain("<!--");
  });

  it("uses user-facing option IDs as native Linear select values", () => {
    expect(
      linearInteractionSignal([
        makeRequest({
          allowFreeform: true,
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
        }),
      ]),
    ).toEqual({
      signal: "select",
      signalMetadata: {
        options: [
          { label: "Approve", value: "approve" },
          { label: "Cancel", value: "cancel" },
        ],
      },
    });
  });

  it("does not emit a select signal for requests without options", () => {
    expect(linearInteractionSignal([makeRequest({ allowFreeform: true })])).toEqual({});
  });
});
