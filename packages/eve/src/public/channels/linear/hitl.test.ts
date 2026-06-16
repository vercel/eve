import { describe, expect, it } from "vitest";

import {
  renderLinearInputRequests,
  resolveLinearPromptInputResponses,
  stripLinearHitlMarker,
} from "#public/channels/linear/hitl.js";
import type { InputRequest } from "#runtime/input/types.js";

function makeRequest(overrides: Partial<InputRequest> = {}): InputRequest {
  return {
    action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
    prompt: "Approve deployment?",
    requestId: "call_1",
    ...overrides,
  };
}

describe("Linear HITL helpers", () => {
  it("renders input requests with a hidden Linear marker", () => {
    const rendered = renderLinearInputRequests([
      makeRequest({
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny", description: "Stop the deployment" },
        ],
      }),
    ]);

    expect(rendered).toContain("Approve deployment?");
    expect(rendered).toContain("1. Approve");
    expect(rendered).toContain("2. Deny - Stop the deployment");
    expect(rendered).toContain("<!-- eve-input:");
    expect(stripLinearHitlMarker(rendered)).not.toContain("eve-input");
  });

  it("resolves Linear prompt text against the latest elicitation marker", () => {
    const elicitation = renderLinearInputRequests([
      makeRequest({
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      }),
    ]);

    expect(
      resolveLinearPromptInputResponses({
        activities: [
          {
            content: { body: elicitation, type: "elicitation" },
            id: "activity_1",
          },
        ],
        body: "approve",
      }),
    ).toEqual([{ optionId: "approve", requestId: "call_1" }]);
  });

  it("supports freeform replies when the original request allowed them", () => {
    const elicitation = renderLinearInputRequests([
      makeRequest({
        allowFreeform: true,
        options: [{ id: "pick_later", label: "Pick later" }],
      }),
    ]);

    expect(
      resolveLinearPromptInputResponses({
        activities: [{ content: { body: elicitation, type: "elicitation" }, id: "activity_1" }],
        body: "Ship it after 5pm",
      }),
    ).toEqual([{ requestId: "call_1", text: "Ship it after 5pm" }]);
  });
});
