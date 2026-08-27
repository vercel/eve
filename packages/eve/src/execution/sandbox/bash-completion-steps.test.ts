import { afterEach, describe, expect, it, vi } from "vitest";

import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import {
  deliverBashCompletionStep,
  formatBashCompletionMessage,
} from "#execution/sandbox/bash-completion-steps.js";

vi.mock("#execution/wire/session-inbox-resume.js", () => ({
  resumeSessionInbox: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe("Bash completion delivery", () => {
  it("sends bounded command output as a queued, replay-deduplicated session message", async () => {
    await deliverBashCompletionStep({
      controlToken: "control",
      deliveryId: "delivery-1",
      observation: {
        exitCode: 7,
        stderr: "failed",
        stdout: "partial",
        truncated: false,
      },
      processId: "process-1",
      sandboxState: { initialized: true, session: null },
      serializedContext: {},
      sessionId: "session-1",
    });

    expect(resumeSessionInbox).toHaveBeenCalledExactlyOnceWith("eve:session:session-1:inbox", {
      kind: "send",
      payload: {
        message:
          "Bash process process-1 completed with exit code 7.\n\nstdout:\npartial\n\nstderr:\nfailed",
      },
      taskDeliveryId: "delivery-1",
      turnPolicy: "queue",
    });
  });

  it("formats empty streams without omitting their labels", () => {
    expect(
      formatBashCompletionMessage("process-1", {
        exitCode: 0,
        stderr: "",
        stdout: "",
        truncated: false,
      }),
    ).toBe("Bash process process-1 completed with exit code 0.\n\nstdout:\n\n\nstderr:\n");
  });
});
