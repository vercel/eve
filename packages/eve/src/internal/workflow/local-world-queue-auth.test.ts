import { describe, expect, it } from "vitest";

import { assertLocalWorkflowQueueAuthEnforced } from "#internal/workflow/local-world-queue-auth.js";

describe("assertLocalWorkflowQueueAuthEnforced", () => {
  it.each(["off", " OFF "])("refuses WORKFLOW_QUEUE_AUTH=%j", (value) => {
    expect(() => assertLocalWorkflowQueueAuthEnforced({ WORKFLOW_QUEUE_AUTH: value })).toThrow(
      /refuses WORKFLOW_QUEUE_AUTH=off/u,
    );
  });

  it.each([undefined, "", "on"])("accepts WORKFLOW_QUEUE_AUTH=%j", (value) => {
    expect(() =>
      assertLocalWorkflowQueueAuthEnforced({ WORKFLOW_QUEUE_AUTH: value }),
    ).not.toThrow();
  });
});
