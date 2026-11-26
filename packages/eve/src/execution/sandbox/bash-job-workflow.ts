import { ownerFieldsOf } from "#execution/agent-sessions/owner.js";
import type { BashCompletedResult, BashJobHandoff } from "#execution/sandbox/bash.js";
import { cancelBashJobStep, pollBashJobStep } from "#execution/sandbox/bash-job-steps.js";
import { findWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { WorkflowStepSandbox } from "#execution/tools/workflow/step-context.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

const POLL_INTERVALS_MS = [500, 1_000, 2_000, 5_000] as const;
const MAX_BASH_TASK_MS = 30 * 60_000;

export async function bashJobTaskWorkflow(
  handoff: BashJobHandoff,
  ctx: WorkflowToolContext,
): Promise<BashCompletedResult> {
  "use workflow";

  return await runBashJobTask(handoff, ctx);
}

export async function runBashJobTask(
  handoff: BashJobHandoff,
  ctx: WorkflowToolContext,
): Promise<BashCompletedResult> {
  const run = findWorkflowToolRunContext(ctx);
  if (run === undefined) {
    throw new Error("Bash job task ran without a workflow tool run context.");
  }
  const sandboxRef: WorkflowStepSandbox = {
    ...ownerFieldsOf(run.agentContext),
    sessionId: run.agentContext.sandbox.sessionId,
    state: run.agentContext.sandbox.state,
  };
  const session = ctx.session;

  let elapsedMs = 0;
  let attempt = 0;
  for (;;) {
    if (ctx.abortSignal.aborted) {
      await cancelBashJobStep(sandboxRef, session, handoff);
      return {
        exitCode: 143,
        status: "completed",
        stderr: "Command cancelled.\n",
        stdout: "",
        truncated: false,
      };
    }
    const polled = await pollBashJobStep(sandboxRef, session, handoff);
    if (polled.status === "completed") {
      return polled.result;
    }
    if (elapsedMs >= MAX_BASH_TASK_MS) {
      await cancelBashJobStep(sandboxRef, session, handoff);
      return {
        exitCode: 124,
        status: "completed",
        stderr: "Command timed out after 30 minutes.\n",
        stdout: "",
        truncated: false,
      };
    }
    const delayMs = POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]!;
    attempt += 1;
    elapsedMs += delayMs;
    const woke = await sleepOrAbort(run.host.sleep(delayMs), ctx.abortSignal);
    if (woke === "aborted") {
      await cancelBashJobStep(sandboxRef, session, handoff);
      return {
        exitCode: 143,
        status: "completed",
        stderr: "Command cancelled.\n",
        stdout: "",
        truncated: false,
      };
    }
  }
}

function sleepOrAbort(timer: Promise<void>, signal: AbortSignal): Promise<"elapsed" | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    void timer.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("elapsed");
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("aborted");
      },
    );
  });
}
