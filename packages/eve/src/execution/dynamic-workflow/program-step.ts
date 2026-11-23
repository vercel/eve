import { ProgramCallError, runProgramSandbox } from "#execution/code-mode/sandbox.js";
import {
  readWorkflowProgramAgentCall,
  readWorkflowProgramAskRequest,
  readWorkflowProgramProgressUpdate,
  readWorkflowProgramSleepSeconds,
  type WorkflowProgramAction,
  type WorkflowProgramAgents,
  type WorkflowProgramCallResult,
  type WorkflowProgramInput,
  type WorkflowProgramPendingAction,
  type WorkflowProgramResolution,
} from "#execution/dynamic-workflow/schema.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonObject, type JsonValue } from "#shared/json.js";

export type WorkflowProgramStepOutcome =
  | {
      readonly logs: readonly string[];
      readonly progress: readonly JsonValue[];
      readonly result: JsonValue;
      readonly status: "completed";
    }
  | {
      readonly error: string;
      readonly logs: readonly string[];
      readonly progress: readonly JsonValue[];
      readonly status: "failed";
    }
  | {
      readonly continuation: string;
      readonly pending: readonly WorkflowProgramPendingAction[];
      readonly progress: readonly JsonValue[];
      readonly status: "interrupted";
    };

export interface WorkflowProgramStepInput {
  readonly callId: string;
  readonly program: WorkflowProgramInput;
  readonly resume?: {
    readonly continuation: string;
    readonly resolutions: readonly WorkflowProgramResolution[];
  };
}

const WORKFLOW_PROGRAM_CONTINUATION_AUDIENCE = "eve.workflow-program/v1";
const WORKFLOW_PROGRAM_HOST_NAMESPACE = "__eve";

export async function runWorkflowProgramStep(
  input: WorkflowProgramStepInput,
): Promise<WorkflowProgramStepOutcome> {
  "use step";

  const waiting = new Map<number, WorkflowProgramAction>();
  const progress: JsonValue[] = [];

  const resumeResult = (resolution: unknown): JsonValue => {
    const outcome = resolution as WorkflowProgramCallResult;
    if (outcome.status === "failed") throw new ProgramCallError(outcome.error);
    return outcome.output ?? null;
  };

  const outcome = await runProgramSandbox({
    audience: WORKFLOW_PROGRAM_CONTINUATION_AUDIENCE,
    callId: input.callId,
    code: input.program.js,
    errorCode: "WORKFLOW_PROGRAM_ERROR",
    errorName: "WorkflowProgramError",
    handlers: {
      agent: {
        errorCode: "WORKFLOW_PROGRAM_AGENT_ERROR",
        errorName: "WorkflowProgramAgentError",
        label: "ctx.agent() input",
        handle: async (request, payload) => {
          if (request.resumed !== undefined) return resumeResult(request.resumed.resolution);
          let call;
          try {
            call = readWorkflowProgramAgentCall(payload);
          } catch (error) {
            throw new ProgramCallError(toErrorMessage(error));
          }
          waiting.set(request.index, { kind: "agent", ...call });
          return request.interrupt();
        },
      },
      ask: {
        label: "ctx.ask() input",
        handle: async (request, payload) => {
          if (request.resumed !== undefined) return resumeResult(request.resumed.resolution);
          let askRequest;
          try {
            const raw = parseJsonObject(payload);
            askRequest = readWorkflowProgramAskRequest(raw.request);
          } catch (error) {
            throw new ProgramCallError(toErrorMessage(error));
          }
          waiting.set(request.index, { kind: "ask", request: askRequest });
          return request.interrupt();
        },
      },
      progress: {
        label: "ctx.progress() input",
        handle: async (_request, payload) => {
          let update: JsonValue;
          try {
            const raw = parseJsonObject(payload);
            if (!Object.hasOwn(raw, "update")) {
              throw new TypeError(
                "Workflow program ctx.progress() requires a JSON-serializable update value.",
              );
            }
            update = readWorkflowProgramProgressUpdate(raw.update);
          } catch (error) {
            throw new ProgramCallError(toErrorMessage(error));
          }
          progress.push(update);
          return null;
        },
      },
      sleep: {
        label: "ctx.sleep() input",
        handle: async (request, payload) => {
          if (request.resumed !== undefined) return resumeResult(request.resumed.resolution);
          let seconds: number;
          try {
            const raw = parseJsonObject(payload);
            seconds = readWorkflowProgramSleepSeconds(raw.seconds);
          } catch (error) {
            throw new ProgramCallError(toErrorMessage(error));
          }
          waiting.set(request.index, { kind: "sleep", seconds });
          return request.interrupt();
        },
      },
    },
    hostNamespace: WORKFLOW_PROGRAM_HOST_NAMESPACE,
    prelude: buildWorkflowProgramPrelude(input.program.agents),
    resume: input.resume,
    security: input.program.continuationSecurity,
  });

  if (outcome.status === "completed") {
    return { logs: outcome.logs, progress, result: outcome.result, status: "completed" };
  }
  if (outcome.status === "failed") {
    return { error: outcome.error, logs: outcome.logs, progress, status: "failed" };
  }
  return {
    continuation: outcome.continuation,
    pending: outcome.pending.map(({ index, interruptionId }) => {
      const action = waiting.get(index);
      if (action === undefined) {
        throw new Error("A workflow program waits on a call it never made.");
      }
      return { action, id: interruptionId };
    }),
    progress,
    status: "interrupted",
  };
}

function buildWorkflowProgramPrelude(agents: WorkflowProgramAgents | undefined): string {
  const frozenAgents = serializeSingleLineJson(agents ?? {});
  return [
    `const __agents = Object.freeze(Object.fromEntries(Object.entries(${frozenAgents}).map(([name, meta]) => [name, Object.freeze(meta)])));`,
    `const ctx = Object.freeze({`,
    `agents: __agents,`,
    `agent: (target, input) => __bridge("agent", { target, input }),`,
    `ask: (request) => __bridge("ask", { request }),`,
    `sleep: (seconds) => __bridge("sleep", { seconds }),`,
    `progress: (update) => __bridge("progress", { update }),`,
    `});`,
  ].join(" ");
}

function serializeSingleLineJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}
