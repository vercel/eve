import { randomBytes } from "node:crypto";

import {
  ProgramCallError,
  runProgramSandbox,
  type ProgramRequest,
} from "#execution/code-mode/sandbox.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

// The steps of a `workflow()` program: the same sandbox, language, and limits as an
// `eve__execute` program, run by a workflow of its own instead of the session's turn. A
// workflow can't reach the session's tools, so the only thing `tools.<name>(input)` calls here is
// an agent, which the workflow opens as a child session.

/** Signs a program's continuations. Generated code never sees it. */
export interface WorkflowProgramSecurity {
  readonly maxAgeMs: number;
  readonly signingKey: string;
}

/** One `tools.<agent>({ message, outputSchema? })` call of a `workflow()` program. */
export interface WorkflowProgramAgentCall {
  readonly target: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

export type WorkflowProgramCallResult =
  | { readonly output: JsonValue; readonly status: "completed" }
  | { readonly error: string; readonly status: "failed" };

export interface WorkflowProgramStepInput {
  readonly callId: string;
  readonly code: string;
  readonly security: WorkflowProgramSecurity;
  readonly resume?: {
    readonly continuation: string;
    readonly resolutions: readonly {
      readonly interruptionId: string;
      readonly value: WorkflowProgramCallResult;
    }[];
  };
}

export type WorkflowProgramStepOutcome =
  | { readonly status: "completed"; readonly result: JsonValue; readonly logs: readonly string[] }
  | { readonly status: "failed"; readonly error: string; readonly logs: readonly string[] }
  | {
      readonly status: "interrupted";
      readonly continuation: string;
      /** The agent calls the program waits on, by the interruption each raised. */
      readonly pending: readonly {
        readonly call: WorkflowProgramAgentCall;
        readonly interruptionId: string;
      }[];
    };

const CONTINUATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Creates replay-stable signing material for one program run. */
export async function createWorkflowProgramSecurityStep(): Promise<WorkflowProgramSecurity> {
  "use step";

  return {
    maxAgeMs: CONTINUATION_MAX_AGE_MS,
    signingKey: randomBytes(32).toString("base64url"),
  };
}

/** Runs or resumes the program until it returns, fails, or waits on agents. */
export async function runWorkflowProgramStep(
  input: WorkflowProgramStepInput,
): Promise<WorkflowProgramStepOutcome> {
  "use step";

  const waiting = new Map<number, WorkflowProgramAgentCall>();
  const call = async (
    request: ProgramRequest,
    { input: callInput, name }: { readonly name: string; readonly input: unknown },
  ): Promise<JsonValue> => {
    if (request.resumed !== undefined) {
      const result = request.resumed.resolution as WorkflowProgramCallResult;
      if (result.status === "failed") throw new ProgramCallError(result.error);
      return result.output;
    }
    waiting.set(request.index, readAgentCall(name, callInput));
    return request.interrupt();
  };
  const search = async (): Promise<JsonValue> => {
    throw new ProgramCallError(
      "search() isn't available in a workflow program, which calls agents only: tools.<agent>({ message }).",
    );
  };

  // A program's own failure is an outcome. Anything the sandbox throws is eve's failure, which
  // the step's retries surface.
  const outcome = await runProgramSandbox({
    call,
    callId: input.callId,
    code: input.code,
    resume: input.resume,
    search,
    security: input.security,
  });
  if (outcome.status !== "interrupted") return outcome;
  return {
    continuation: outcome.continuation,
    pending: outcome.pending.map(({ index, interruptionId }) => {
      const agentCall = waiting.get(index);
      if (agentCall === undefined) {
        throw new Error("A workflow program waits on a call it never made.");
      }
      return { call: agentCall, interruptionId };
    }),
    status: "interrupted",
  };
}

/** A `workflow()` program's input to an agent: a message, and the shape its reply should take. */
function readAgentCall(name: string, input: unknown): WorkflowProgramAgentCall {
  const shape = `Call an agent as tools.${name}({ message, outputSchema? }).`;
  if (!isObject(input) || typeof input.message !== "string") {
    throw new ProgramCallError(`"${name}" takes a message string. ${shape}`);
  }
  const { message, outputSchema, ...rest } = input;
  const unknown = Object.keys(rest)[0];
  if (unknown !== undefined) {
    throw new ProgramCallError(
      `"${name}" takes no "${unknown}": each call starts a new agent session. ${shape}`,
    );
  }
  if (outputSchema === undefined) return { message, target: name };
  if (!isObject(outputSchema)) {
    throw new ProgramCallError(`"${name}" takes outputSchema as a JSON Schema object.`);
  }
  return { message, outputSchema: outputSchema as JsonObject, target: name };
}
