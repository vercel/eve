import { describe, expect, it, vi } from "vitest";

import { validateWorkflowWorld } from "#internal/workflow/validate-world.js";

describe("validateWorkflowWorld", () => {
  it("accepts a valid Workflow world", () => {
    expect(() =>
      validateWorkflowWorld({
        world: createMockWorld(),
      }),
    ).not.toThrow();
  });

  it("rejects worlds without queue handlers", () => {
    expect(() =>
      validateWorkflowWorld({
        world: {
          events: {},
          specVersion: 5,
        },
      }),
    ).toThrow("Configured Workflow world factory did not return a valid World.");
  });

  it("rejects worlds without event storage", () => {
    expect(() =>
      validateWorkflowWorld({
        world: {
          createQueueHandler: vi.fn(),
          specVersion: 5,
        },
      }),
    ).toThrow("Configured Workflow world factory did not return a valid World.");
  });

  it("rejects worlds without a spec version", () => {
    expect(() =>
      validateWorkflowWorld({
        world: {
          createQueueHandler: vi.fn(),
          events: {},
        },
      }),
    ).toThrow("Configured Workflow world factory did not return a valid World.");
  });
});

function createMockWorld() {
  return {
    createQueueHandler: vi.fn(),
    events: {},
    specVersion: 5,
  };
}
