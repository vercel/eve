import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { SessionContext } from "#context/session-context.js";
import { agent } from "#execution/tools/workflow/agent.js";
import type {
  AgentInput,
  AgentOptions,
  ResumableWorkflowToolContext,
  WorkflowToolContext,
} from "#tools/workflow-definition.js";
import { ask, attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import {
  type WorkflowToolRunOutcome,
  type WorkflowToolRunOwner,
  type WorkflowToolRunRef,
  type WorkflowToolRunReport,
} from "#execution/tools/workflow/messages.js";
import type { GenerationCall, Generations } from "#execution/tools/workflow/generations.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { readRegisteredWorkflow } from "#execution/workflow-registry.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";

export interface WorkflowBodyDefinition {
  /** Snapshot added for new runs; absent only when resuming an older durable payload. */
  readonly agents?: WorkflowToolContext["agents"];
  readonly callId: string;
  /**
   * Whether the owning session can reach a human. `false` makes `ctx.ask()`
   * resolve as `unavailable` instead of waiting for an answer no one can give.
   */
  readonly canRequestInput?: boolean;
  readonly executeInput?: JsonValue;
  readonly input: JsonObject;

  readonly session: SessionContext["session"];
  readonly stepIndex: number;
  /** The owner's task for this call; the run reports under it. */
  readonly taskId: string;
  readonly toolName: string;
  readonly workflowId: string;
  /** The run stays alive between generations; `ctx` gains `receive` and `reply`. */
  readonly resumable?: boolean;
}

export interface WorkflowBodyInput extends WorkflowBodyDefinition {
  readonly owner: WorkflowToolRunOwner;
}

export interface WorkflowBodyResult {
  readonly outcome: WorkflowToolRunOutcome;
  readonly reportCount: number;
}

type WorkflowToolExecute = (
  input: unknown,
  ctx: WorkflowToolContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/**
 * Executes one registered workflow body and reports progress to its owner. A
 * resumable body's context follows its current generation (`generations`).
 */
export async function executeWorkflowBody(
  input: WorkflowBodyInput & { readonly runId?: string },
  signal: AbortSignal,
  generations?: Generations,
): Promise<WorkflowBodyResult> {
  const base = createWorkflowBodyRef(input);
  const current = (): WorkflowToolRunRef =>
    generations === undefined
      ? base
      : { ...base, ...generationRef(generations.call), generation: generations.generation };
  const ctx = createWorkflowBodyContext(input, signal, generations);
  attachWorkflowToolRunContext(ctx, {
    canRequestInput: input.canRequestInput,
    get from() {
      return current();
    },
    owner: input.owner,
    get replied() {
      return generations?.replied === true;
    },
  });
  let reportCount = 0;

  try {
    const execute = resolveWorkflowToolExecute(input);
    const result = execute(input.executeInput ?? input.input, ctx);
    let output: JsonValue;
    if (!isAsyncIterable(result)) {
      output = await result;
    } else {
      const iterator = result[Symbol.asyncIterator]();
      let last: JsonValue | undefined;
      let next = await iterator.next();
      while (next.done !== true) {
        last = next.value;
        const report: WorkflowToolRunReport = { from: current(), update: next.value };
        await resumeHookStep(input.owner.inbox, { kind: "report", ...report });
        reportCount += 1;
        generations?.noteReport();
        next = await iterator.next();
      }
      // A resumable body's yields are progress; only its reply or return is a result.
      output =
        (next.value as JsonValue | undefined) ??
        (generations === undefined ? last : undefined) ??
        null;
    }
    return { outcome: { output, status: "completed" }, reportCount };
  } catch (error) {
    // A throw after a cancel is the cancel; a resumable body's own cancel
    // stops only its current generation.
    const aborted = signal.aborted
      ? signal
      : generations?.signal.aborted === true && !generations.replied
        ? generations.signal
        : undefined;
    if (aborted !== undefined) {
      return {
        outcome: {
          reason:
            aborted.reason instanceof Error ? aborted.reason.message : String(aborted.reason ?? ""),
          status: "cancelled",
        },
        reportCount,
      };
    }
    return { outcome: { error: normalizeSerializableError(error), status: "failed" }, reportCount };
  }
}

export function createWorkflowBodyRef(
  input: WorkflowBodyDefinition & { readonly runId?: string },
): WorkflowToolRunRef {
  return {
    ...generationRef(firstGenerationCall(input)),
    generation: 1,
    runId: input.runId ?? getWorkflowMetadata().workflowRunId,
    taskId: input.taskId,
    toolName: input.toolName,
  };
}

/** The call that started a run's first generation. */
export function firstGenerationCall(input: WorkflowBodyDefinition): GenerationCall {
  return {
    callId: input.callId,
    input: input.input,
    stepIndex: input.stepIndex,
    turn: { id: input.session.turn.id, sequence: input.session.turn.sequence },
  };
}

function generationRef(
  call: GenerationCall,
): Pick<WorkflowToolRunRef, "callId" | "input" | "sequence" | "stepIndex" | "turnId"> {
  return {
    callId: call.callId,
    input: call.input,
    sequence: call.turn.sequence,
    stepIndex: call.stepIndex,
    turnId: call.turn.id,
  };
}

function resolveWorkflowToolExecute(input: WorkflowBodyInput): WorkflowToolExecute {
  const execute = readRegisteredWorkflow(input.workflowId);
  if (typeof execute !== "function") {
    throw new Error(
      `Tool "${input.toolName}" is not registered as a workflow in this deployment (${input.workflowId}). The tool was renamed or removed after this run started.`,
    );
  }
  return execute as WorkflowToolExecute;
}

function createWorkflowBodyContext(
  input: WorkflowBodyInput,
  signal: AbortSignal,
  generations: Generations | undefined,
): ToolContext & WorkflowToolContext {
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. Tool "${input.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };
  const ctx: ToolContext & WorkflowToolContext = {
    agent: ((target: string, agentInput: AgentInput, options?: AgentOptions) =>
      agent(ctx, target, agentInput, options)) as WorkflowToolContext["agent"],
    agents: Object.freeze(
      Object.fromEntries(
        Object.entries(input.agents ?? {}).map(([name, metadata]) => [
          name,
          Object.freeze({ ...metadata }),
        ]),
      ),
    ),
    ask: (request) => ask(ctx, request),
    abortSignal: signal,
    callId: input.callId,
    getSandbox: () => unavailable("getSandbox()", "the session sandbox belongs to the turn"),
    getToken: () =>
      unavailable("getToken()", 'pass ctx directly to a "use step" helper to resolve credentials'),
    requireAuth: () =>
      unavailable(
        "requireAuth()",
        'pass ctx directly to a "use step" helper to request authorization',
      ),
    session: input.session,
    toolName: input.toolName,
  };
  if (generations === undefined) return ctx;
  // A generation's context follows the call that started it; each generation
  // has its own signal, so a cancel stops the current work, not the task.
  Object.defineProperties(ctx, {
    abortSignal: { enumerable: true, get: () => generations.signal },
    callId: { enumerable: true, get: () => generations.call.callId },
    session: {
      enumerable: true,
      get: () => ({ ...input.session, turn: generations.call.turn }),
    },
  });
  const resumable: Pick<
    ResumableWorkflowToolContext<JsonObject, JsonValue>,
    "receive" | "reply"
  > = {
    receive: () => generations.receive(),
    reply: (output) => generations.reply(output),
  };
  return Object.assign(ctx, resumable);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<JsonValue>)[Symbol.asyncIterator] === "function"
  );
}
