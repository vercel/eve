import { describe, expect, it, vi } from "vitest";
import { workflowToolRunWorkflow } from "./workflow.js";
import type { WorkflowToolRunInput } from "./types.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), resume: vi.fn(), control: vi.fn() }));
vi.mock("#execution/tools/workflow/body.js", () => ({
  createWorkflowBodyRef: () => ({ callId: "call", runId: "run", toolName: "code_mode" }),
  executeWorkflowBody: (...args: unknown[]) => mocks.execute(...args),
}));
vi.mock("#execution/tools/workflow/run-control.js", () => ({
  openWorkflowToolRunControlInbox: mocks.control,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: mocks.resume }));
vi.mock("#compiled/@workflow/core/index.js", () => ({ sleep: async () => {} }));

describe("Code Mode state reporting", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "reports settled updates on %s, including an unfinished body",
    async (status) => {
      mocks.resume.mockClear();
      const controller = new AbortController();
      let cancel: (reason: Error) => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = reject;
      });
      mocks.control.mockReturnValue({ signal: controller.signal, cancelled, reason: () => "stop" });
      mocks.execute.mockImplementation(async (input: WorkflowToolRunInput) => {
        input.codeMode!.serializedContext = { todo: "saved" };
        if (status === "cancelled") {
          const reason = new Error("stop");
          controller.abort(reason);
          cancel(reason);
          return await new Promise<never>(() => {});
        }
        return {
          outcome:
            status === "completed" ? { status, output: "result" } : { status, error: "failed" },
          reportCount: 0,
        };
      });
      const input: WorkflowToolRunInput = {
        callId: "call",
        hookToken: "control",
        input: {},
        owner: { inbox: "owner" },
        session: {
          id: "session",
          auth: { current: null, initiator: null },
          turn: { id: "turn", sequence: 1 },
        },
        stepIndex: 0,
        toolName: "code_mode",
        workflowId: "workflow//test//code-mode",
        codeMode: {
          serializedContext: { todo: "old" },
          sessionState: {
            version: 1,
            sessionId: "session",
            continuationToken: "token",
            hasProxyInputRequests: false,
            emissionState: { sequence: 1, stepIndex: 0, turnId: "turn", sessionStarted: true },
          },
        },
      };
      await workflowToolRunWorkflow(input);
      expect(mocks.resume).toHaveBeenCalledWith(
        "owner",
        expect.objectContaining({
          kind: "outcome",
          result: expect.objectContaining({
            status,
            stateChanges: [{ path: ["serializedContext", "todo"], before: "old", after: "saved" }],
          }),
        }),
        { ifPresent: status === "cancelled" },
      );
      expect(input.codeMode?.serializedContext).toEqual({ todo: "old" });
    },
  );
});
