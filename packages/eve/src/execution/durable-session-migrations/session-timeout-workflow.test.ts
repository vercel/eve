import { describe, expect, it } from "vitest";

import {
  createSessionTimeoutWorkflowInput,
  migrateSessionTimeoutWorkflowInput,
  SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION,
} from "./session-timeout-workflow.js";

describe("session timeout workflow input migrations", () => {
  it("stamps new workflow inputs with v1", () => {
    const deadline = new Date("2026-02-01T00:00:00.000Z");

    expect(createSessionTimeoutWorkflowInput({ deadline, token: "session-timeout" })).toEqual({
      deadline,
      token: "session-timeout",
      version: SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION,
    });
  });

  it("migrates pre-version inputs without dropping additive fields", () => {
    const input = {
      additiveField: { retained: true },
      deadline: new Date("2026-02-01T00:00:00.000Z"),
      token: "session-timeout",
    };

    expect(migrateSessionTimeoutWorkflowInput(input)).toEqual({
      ...input,
      version: SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION,
    });
  });

  it("returns current inputs unchanged and rejects newer versions", () => {
    const input = {
      additiveField: "retained",
      deadline: new Date("2026-02-01T00:00:00.000Z"),
      token: "session-timeout",
      version: SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION,
    };

    expect(migrateSessionTimeoutWorkflowInput(input)).toBe(input);
    expect(() => migrateSessionTimeoutWorkflowInput({ version: 2 })).toThrow(
      /session timeout workflow input: encountered version 2/,
    );
  });

  it("rejects malformed pre-version inputs", () => {
    expect(() =>
      migrateSessionTimeoutWorkflowInput({ deadline: "tomorrow", token: "timeout" }),
    ).toThrow(/not a recognized pre-version shape/);
    expect(() =>
      migrateSessionTimeoutWorkflowInput({
        deadline: new Date("2026-02-01T00:00:00.000Z"),
        token: "timeout",
        version: "1",
      }),
    ).toThrow(/has no numeric "version" field/);
  });
});
