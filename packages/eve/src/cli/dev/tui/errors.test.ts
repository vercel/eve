import { describe, expect, it } from "vitest";

import type { StepFailedStreamEvent } from "#client/index.js";

import { formatGatewayAuthFailureNotice, isGatewayAuthFailure } from "./errors.js";

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

describe("isGatewayAuthFailure", () => {
  it("matches the machine-readable gatewayName the harness merges into details", () => {
    expect(isGatewayAuthFailure(stepFailed({ gatewayName: "GatewayAuthenticationError" }))).toBe(
      true,
    );
  });

  it("falls back to the config-summary name", () => {
    expect(isGatewayAuthFailure(stepFailed({ name: "AI Gateway authentication failed" }))).toBe(
      true,
    );
  });

  it("rejects other gateway errors and missing details", () => {
    expect(isGatewayAuthFailure(stepFailed({ gatewayName: "GatewayRateLimitError" }))).toBe(false);
    expect(isGatewayAuthFailure(stepFailed({ name: "Model provider API key missing" }))).toBe(
      false,
    );
    expect(isGatewayAuthFailure(stepFailed())).toBe(false);
  });
});

describe("formatGatewayAuthFailureNotice", () => {
  it("points a rejected API key at /model or the env file", () => {
    const notice = formatGatewayAuthFailureNotice(
      stepFailed({}, "AI Gateway rejected the provided API key. Update or unset…"),
    );
    expect(notice).toContain("rejected your AI_GATEWAY_API_KEY");
    expect(notice).toContain("/model");
  });

  it("points a rejected OIDC token at /model", () => {
    const notice = formatGatewayAuthFailureNotice(
      stepFailed({}, "AI Gateway rejected the OIDC token. Run `eve link`…"),
    );
    expect(notice).toContain("OIDC token");
    expect(notice).toContain("/model");
  });

  it("defaults to the missing-credentials line", () => {
    const notice = formatGatewayAuthFailureNotice(
      stepFailed({}, "AI Gateway received no credentials…"),
    );
    expect(notice).toBe(
      "There is no AI_GATEWAY_API_KEY set. Run /model to connect this to a project and refresh AI Gateway credentials, or set it manually in .env.local.",
    );
  });
});
