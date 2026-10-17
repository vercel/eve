import { sleep } from "#compiled/@workflow/core/index.js";
import { askToApproveAction } from "#execution/tools/workflow/ask.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { toErrorMessage } from "#shared/errors.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import type { ExecuteInput } from "./tool.js";
import type { ProgramCallResult, ProgramLanguage, ProgramStep, ProgramTiming } from "./runtime.js";
import {
  initializeProgramStep,
  runProgramStep,
  approveProgramCallStep,
  recordProgramCallStartedStep,
  dispatchProgramCallStep,
  type ProgramContext,
} from "./program-step.js";

/** Durable driver; interpreters only park, and each tool gets a separate durable step. */
export async function executeProgramWorkflow(
  input: ExecuteInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";
  const program = input as ExecuteInput & { language: ProgramLanguage; context: ProgramContext };
  if (program.context === undefined)
    return {
      status: "failed",
      error: "Code-mode execution context is missing.",
      interpreter: { startupMs: 0, runMs: 0 },
      errorClass: "runtime",
      logs: [],
    };
  const timeoutMs = Math.min(300000, Math.max(1, input.timeoutMs ?? 300000));
  const initialized = await initializeProgramStep(program.context, timeoutMs);
  const start = { ...initialized, source: program.source };
  const results: ProgramCallResult[] = [];
  const approvedKeys: string[] = [];
  let outcome = await runProgramStep(program.language, start);
  const interpreter = {
    startupMs: outcome.timing?.startupMs ?? 0,
    runMs: outcome.timing?.runMs ?? 0,
  };
  let expired = false;
  const deadline = sleep(new Date(initialized.limits.deadlineAt)).then(() => {
    expired = true;
  });
  while (outcome.status === "parked") {
    ctx.abortSignal.throwIfAborted();
    const batch = Promise.all(
      outcome.calls.map(async (call): Promise<ProgramCallResult> => {
        const callId = `${ctx.callId}:program:${call.index}`;
        const deadlineFailure = (): ProgramCallResult => ({
          index: call.index,
          status: "failed",
          error: "Program deadline exceeded before the tool call started.",
        });
        try {
          if (expired) return deadlineFailure();
          const approval = await approveProgramCallStep(
            program.context,
            call,
            callId,
            approvedKeys,
          );
          if (approval.status === "denied")
            return { index: call.index, status: "failed", error: approval.error };
          if (approval.status === "required") {
            const answer = await Promise.race([
              askToApproveAction(
                ctx,
                {
                  prompt: `Approve ${call.tool}?`,
                  allowFreeform: false,
                  display: "confirmation",
                  options: [
                    { id: "approve", label: "Approve" },
                    { id: "cancel", label: "Cancel" },
                  ],
                },
                {
                  kind: "tool-call",
                  callId,
                  toolName: call.tool,
                  input: approval.input,
                },
              ),
              deadline.then(() => ({ status: "deadline" as const })),
            ]);
            if (answer.status === "deadline")
              return {
                index: call.index,
                status: "failed",
                error: "Program deadline exceeded while waiting for approval.",
              };
            if (answer.status !== "answered" || answer.optionId !== "approve")
              return {
                index: call.index,
                status: "failed",
                error: `The user did not approve ${call.tool}.`,
              };
          }
          if (expired) return deadlineFailure();
          approvedKeys.push(approval.key);
          const marker = await recordProgramCallStartedStep(callId);
          if (expired) return deadlineFailure();
          const dispatched = await dispatchProgramCallStep(
            ctx,
            program.context,
            { ...call, input: approval.input },
            marker,
            approvedKeys,
          );
          if (!("status" in dispatched))
            throw new Error("Tool authorization was not resumed through its workflow step.");
          return dispatched;
        } catch (error) {
          ctx.abortSignal.throwIfAborted();
          return { index: call.index, status: "failed", error: toErrorMessage(error) };
        }
      }),
    );
    const settling = await Promise.race([batch, deadline.then(() => undefined)]);
    if (settling === undefined) {
      const expired = await runProgramStep(program.language, {
        ...start,
        state: outcome.state,
        results,
      });
      if (expired.status === "parked")
        throw new Error("Program deadline expired without terminating the runtime.");
      interpreter.startupMs += expired.timing?.startupMs ?? 0;
      interpreter.runMs += expired.timing?.runMs ?? 0;
      return parseJsonValue(withFailureLogNotice(expired, interpreter));
    }
    results.push(...settling);
    outcome = await runProgramStep(program.language, { ...start, state: outcome.state, results });
    interpreter.startupMs += outcome.timing?.startupMs ?? 0;
    interpreter.runMs += outcome.timing?.runMs ?? 0;
  }
  return parseJsonValue(withFailureLogNotice(outcome, interpreter));
}

function withFailureLogNotice(
  outcome: Exclude<ProgramStep, { status: "parked" }>,
  interpreter: ProgramTiming,
) {
  const { timing: _timing, ...result } = outcome;
  return outcome.status === "failed" &&
    (outcome.errorClass === "deadline" || outcome.errorClass === "memory")
    ? { ...result, interpreter, logsMayBeTruncated: true }
    : { ...result, interpreter };
}
