import { describe, expect, it } from "vitest";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";

const FIRST_MESSAGE = "Please summarize the synthetic release checklist before the rollout.";
const SECOND_MESSAGE = "Proceed after the synthetic health check passes.";
const FIRST_CALLBACK_CONTEXT = "Release policy: use the synthetic staging environment only.";
const SECOND_CALLBACK_CONTEXT = "Release policy: wait for the synthetic health check.";

describe("coalesceDeliverPayloads", () => {
  it("preserves messages and authored callback context in arrival order", () => {
    const result = coalesceDeliverPayloads([
      {
        context: [FIRST_CALLBACK_CONTEXT],
        message: FIRST_MESSAGE,
      },
      {
        context: [SECOND_CALLBACK_CONTEXT],
        message: SECOND_MESSAGE,
      },
    ]);

    expect(result).toEqual({
      context: [FIRST_CALLBACK_CONTEXT, SECOND_CALLBACK_CONTEXT],
      message: `${FIRST_MESSAGE}\n\n${SECOND_MESSAGE}`,
    });
  });

  it("omits blank messages after preserving adapter fields", () => {
    const result = coalesceDeliverPayloads([
      { adapterMetadata: { deliverySequence: 1 }, message: " " },
      { message: "\n" },
    ]);

    expect(result).toEqual({ adapterMetadata: { deliverySequence: 1 } });
  });

  it("preserves queued input responses and adapter fields", () => {
    const result = coalesceDeliverPayloads([
      {
        adapterMetadata: { callbackKind: "button", deliverySequence: 1 },
        inputResponses: [{ optionId: "approve", requestId: "approval_synthetic_release" }],
        preservedAdapterMetadata: { source: "synthetic-callback" },
      },
      {
        adapterMetadata: { callbackKind: "message", deliverySequence: 2 },
        inputResponses: [
          { requestId: "question_synthetic_rollout", text: "Begin with the synthetic canary." },
        ],
        nextAdapterMetadata: { callbackVersion: 2 },
        preservedAdapterMetadata: undefined,
      },
    ]);

    expect(result).toEqual({
      adapterMetadata: { callbackKind: "message", deliverySequence: 2 },
      inputResponses: [
        { optionId: "approve", requestId: "approval_synthetic_release" },
        { requestId: "question_synthetic_rollout", text: "Begin with the synthetic canary." },
      ],
      nextAdapterMetadata: { callbackVersion: 2 },
      preservedAdapterMetadata: { source: "synthetic-callback" },
    });
  });
});
