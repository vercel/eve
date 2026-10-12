import { describe, expect, it } from "vitest";

import { linearInteractionSignal, renderLinearInteractions } from "#public/channels/linear/hitl.js";
import type { AskedInteraction } from "#channel/interaction-prompts.js";

function makeRequest(overrides: Partial<AskedInteraction> = {}): AskedInteraction {
  return {
    call: { callId: "call_1", input: {}, name: "ask_question" },
    prompt: "Approve deployment?",
    interactionId: "call_1",
    ...overrides,
    kind: overrides.kind ?? "question",
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
