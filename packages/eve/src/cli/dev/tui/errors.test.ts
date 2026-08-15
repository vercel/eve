import { describe, expect, it } from "vitest";

import type { StepFailedStreamEvent } from "#client/index.js";

import { failureDetails, localFailureHint } from "./errors.js";

function stepFailed(
  details?: Record<string, unknown>,
  message = "model call failed",
): StepFailedStreamEvent {
  const data: Record<string, unknown> = {
    code: "MODEL_CALL_FAILED",
    message,
    sequence: 0,
    stepIndex: 0,
    turnId: "t0",
  };
  if (details !== undefined) data.details = details;
  return { type: "step.failed", data } as StepFailedStreamEvent;
}

describe("failureDetails", () => {
  it("projects the structured catalog fields and drops everything else", () => {
    const details = failureDetails(
      stepFailed({
        semanticErrorId: "gateway-auth-invalid-api-key",
        hint: "  Run `eve link`.  ",
        detail: "TypeError: boom\n    at x",
        gatewayName: "GatewayAuthenticationError",
      }),
    );
    expect(details).toEqual({
      semanticErrorId: "gateway-auth-invalid-api-key",
      hint: "Run `eve link`.",
      detail: "TypeError: boom\n    at x",
    });
  });

  it("returns an empty projection for missing or malformed details", () => {
    expect(failureDetails(stepFailed())).toEqual({});
    expect(failureDetails(stepFailed({ hint: "   " }))).toEqual({});
  });
});

describe("localFailureHint", () => {
  it("swaps gateway-auth catalog ids for the in-session /model fix", () => {
    for (const id of [
      "gateway-auth-invalid-api-key",
      "gateway-auth-invalid-oidc-token",
      "gateway-auth-missing-credentials",
    ]) {
      const hint = localFailureHint(stepFailed({ semanticErrorId: id }));
      expect(hint).toContain("/model");
    }
  });

  it("keeps the harness hint for every other failure", () => {
    expect(
      localFailureHint(stepFailed({ semanticErrorId: "network-request-failed" })),
    ).toBeUndefined();
    expect(localFailureHint(stepFailed())).toBeUndefined();
  });
});
