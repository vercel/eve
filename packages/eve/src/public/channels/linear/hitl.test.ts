import { describe, expect, it } from "vitest";

import {
  linearInputRequestSignal,
  renderLinearInputRequests,
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
  it("renders only user-visible input request text", () => {
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
    expect(rendered).not.toContain("eve-input");
    expect(rendered).not.toContain("<!--");
  });

  it("uses user-facing option IDs as native Linear select values", () => {
    expect(
      linearInputRequestSignal([
        makeRequest({
          allowFreeform: true,
          options: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny" },
          ],
        }),
      ]),
    ).toEqual({
      signal: "select",
      signalMetadata: {
        options: [
          { label: "Approve", value: "approve" },
          { label: "Deny", value: "deny" },
        ],
      },
    });
  });

  it("does not emit a select signal for requests without options", () => {
    expect(linearInputRequestSignal([makeRequest({ allowFreeform: true })])).toEqual({});
  });
});
