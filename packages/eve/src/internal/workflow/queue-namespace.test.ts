import { describe, expect, it } from "vitest";

import {
  EVE_WORKFLOW_QUEUE_NAMESPACE,
  WORKFLOW_QUEUE_NAMESPACE_ENV,
} from "#internal/workflow/queue-namespace.js";

describe("workflow queue namespace", () => {
  it("installs the eve namespace when the module loads", () => {
    expect(process.env[WORKFLOW_QUEUE_NAMESPACE_ENV]).toBe(EVE_WORKFLOW_QUEUE_NAMESPACE);
  });
});
