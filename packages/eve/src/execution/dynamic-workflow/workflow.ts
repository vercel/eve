import { sleep } from "#compiled/@workflow/core/index.js";
import {
  DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES,
  parseWorkflowProgramOptions,
  type WorkflowProgramAction,
  type WorkflowProgramAgentCall,
  type WorkflowProgramAgents,
  type WorkflowProgramCallResult,
  type WorkflowProgramInput,
  type WorkflowProgramResolution,
} from "#execution/dynamic-workflow/schema.js";
import {
  runWorkflowProgramStep,
  type WorkflowProgramStepOutcome,
} from "#execution/dynamic-workflow/program-step.js";
import { createWorkflowProgramContinuationSecurityStep } from "#execution/dynamic-workflow/security-step.js";
import { findWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import type { MessageContent } from "#shared/message-content.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

export interface JsProgramOptions {
  readonly maxSubagents?: number;
}

const MAX_FAILURE_LOG_CHARS = 4_000;

export async function runJsProgram(
  js: string,
  ctx: WorkflowToolContext,
  options: JsProgramOptions,
): Promise<JsonValue> {
  if (typeof js !== "string") throw new TypeError('workflow requires a "js" string.');
  const optionsWithDefaults = parseWorkflowProgramOptions({
    maxSubagents: options.maxSubagents ?? DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  });
  const program: WorkflowProgramInput = {
    ...optionsWithDefaults,
    agents: snapshotAgents(ctx),
    continuationSecurity: await createWorkflowProgramContinuationSecurityStep(),
    js,
  };
  const base = { callId: ctx.callId, program };
  const calls: Record<"completed" | "failed", number> = { completed: 0, failed: 0 };
  let agentCalls = 0;

  let outcome: WorkflowProgramStepOutcome = await runWorkflowProgramStep(base);
  await emitProgress(ctx, outcome.progress);

  while (outcome.status === "interrupted") {
    ctx.abortSignal.throwIfAborted();
    const resolutions = await Promise.all(
      outcome.pending.map(async ({ action, id }): Promise<WorkflowProgramResolution> => {
        const value = await settleProgramAction(
          ctx,
          action,
          () => {
            const invocationIndex = agentCalls++;
            return invocationIndex < program.maxSubagents;
          },
          program.maxSubagents,
        );
        calls[value.status] += 1;
        return { interruptionId: id, value };
      }),
    );
    outcome = await runWorkflowProgramStep({
      ...base,
      resume: { continuation: outcome.continuation, resolutions },
    });
    await emitProgress(ctx, outcome.progress);
  }

  if (outcome.status === "completed") {
    return outcome.logs.length === 0
      ? outcome.result
      : { logs: [...outcome.logs], result: outcome.result };
  }
  throw new Error(formatProgramFailure(outcome.error, calls, outcome.logs));
}

async function settleProgramAction(
  ctx: WorkflowToolContext,
  action: WorkflowProgramAction,
  reserveAgentCall: () => boolean,
  maxSubagents: number,
): Promise<WorkflowProgramCallResult> {
  if (action.kind === "agent" && !reserveAgentCall()) {
    return {
      status: "failed",
      error: `WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED: workflow may invoke at most ${String(maxSubagents)} agents; "${action.target}" was not called.`,
    };
  }
  try {
    const output = await executeProgramAction(ctx, action);
    return { status: "completed", output };
  } catch (error) {
    ctx.abortSignal.throwIfAborted();
    return { status: "failed", error: toErrorMessage(error) };
  }
}

async function executeProgramAction(
  ctx: WorkflowToolContext,
  action: WorkflowProgramAction,
): Promise<JsonValue> {
  switch (action.kind) {
    case "agent":
      return await callProgramAgent(ctx, action);
    case "ask": {
      const answer = await ctx.ask(action.request, { signal: ctx.abortSignal });
      ctx.abortSignal.throwIfAborted();
      return parseJsonValue(answer);
    }
    case "sleep":
      return await sleepProgram(ctx, action.seconds);
  }
}

async function callProgramAgent(
  ctx: WorkflowToolContext,
  call: WorkflowProgramAgentCall,
): Promise<JsonValue> {
  const { files, message, model, outputSchema } = call.input;
  const content: MessageContent<string | URL> =
    files !== undefined && files.length > 0
      ? [
          { type: "text", text: message },
          ...files.map((file) => ({
            type: "file" as const,
            data: file.url,
            mediaType: file.mediaType,
            ...(file.filename !== undefined && { filename: file.filename }),
          })),
        ]
      : message;
  const session = model === undefined ? ctx.agent(call.target) : ctx.agent(call.target, { model });
  const response = await session.send<JsonValue>(content, {
    outputSchema,
    signal: ctx.abortSignal,
  });
  const result = await response.result();
  if (result.status === "failed") {
    throw new Error(`Agent "${call.target}" failed to handle the message: ${result.error.message}`);
  }
  const output = outputSchema !== undefined ? (result.data ?? null) : (result.reply ?? null);
  const bytes = new TextEncoder().encode(JSON.stringify(output)).byteLength;
  if (bytes > WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES) {
    throw new Error(
      `Agent "${call.target}" replied with ${String(bytes)} bytes of JSON, over the ${String(WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES)} byte limit for a ctx.agent() result.`,
    );
  }
  return output;
}

async function sleepProgram(ctx: WorkflowToolContext, seconds: number): Promise<JsonValue> {
  const ms = Math.ceil(seconds * 1_000);
  const run = findWorkflowToolRunContext(ctx);
  const timer = run !== undefined ? run.host.sleep(ms) : sleep(ms);
  await raceWithAbort(timer, ctx.abortSignal);
  ctx.abortSignal.throwIfAborted();
  return { waitedSeconds: seconds };
}

async function raceWithAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    signal.throwIfAborted();
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    void promise.catch(() => undefined);
  }
}

async function emitProgress(
  ctx: WorkflowToolContext,
  updates: readonly JsonValue[],
): Promise<void> {
  if (updates.length === 0) return;
  const run = findWorkflowToolRunContext(ctx);
  if (run === undefined) return;
  for (const update of updates) {
    await run.owner.send({ from: run.from, kind: "report", update });
  }
}

function snapshotAgents(ctx: WorkflowToolContext): WorkflowProgramAgents {
  const raw = ctx.agents;
  if (raw === undefined || raw === null) return {};
  const snapshot: Record<string, { readonly description: string }> = {};
  for (const [name, metadata] of Object.entries(raw)) {
    snapshot[name] = { description: metadata.description };
  }
  return snapshot;
}

function formatProgramFailure(
  error: string,
  calls: Readonly<Record<"completed" | "failed", number>>,
  logs: readonly string[],
): string {
  const parts = [error];
  if (calls.completed > 0) {
    parts.push("Calls that completed before this are not undone.");
  }
  if (calls.completed + calls.failed > 0) {
    parts.push(`Calls: ${String(calls.completed)} completed, ${String(calls.failed)} failed.`);
  }
  const message = parts.join(" ");
  if (logs.length === 0) return message;
  const consoleOutput = `\nconsole output:\n${logs.join("\n")}`;
  return `${message}${consoleOutput.slice(0, MAX_FAILURE_LOG_CHARS)}`;
}

export { MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS };
