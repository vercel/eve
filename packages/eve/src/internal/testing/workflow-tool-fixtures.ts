/**
 * Authored workflow tool bodies for integration tests. Each exported
 * `"use workflow"` function stands in for a tool's `execute`: the test tier's
 * bundler registers them in the driver, and the harness sees the stubs the
 * client transform leaves behind, exactly as it would for an application's
 * `agent/tools/*.ts`.
 */

import { createHook, sleep as workflowSleep } from "#compiled/@workflow/core/index.js";

import { ask } from "#execution/tools/workflow/ask.js";
import type { ToolContext } from "#tools/definition.js";
import type { TaskExec, TaskMessage, TaskSetState } from "#tools/task.js";

export interface DeployInput {
  readonly service: string;
}

export async function deployServiceWorkflow(
  input: DeployInput,
  ctx: ToolContext,
): Promise<{ readonly callId: string; readonly plan: string; readonly sessionId: string }> {
  "use workflow";

  const plan = await planDeployStep(input.service);
  return { callId: ctx.callId, plan, sessionId: ctx.session.id };
}

export async function confirmDeployWorkflow(
  input: DeployInput,
  ctx: ToolContext,
): Promise<{ readonly approved: boolean; readonly service: string }> {
  "use workflow";

  const plan = await planDeployStep(input.service);
  const answer = await ask(ctx, {
    display: "confirmation",
    options: [
      { id: "approve", label: "Deploy", style: "primary" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Apply ${plan}?`,
  });
  return { approved: answer.optionId === "approve", service: input.service };
}

export async function failingDeployWorkflow(input: DeployInput): Promise<never> {
  "use workflow";

  await planDeployStep(input.service);
  throw new Error(`deploy of ${input.service} exploded`);
}

export async function subagentShapedDeployWorkflow(): Promise<{
  readonly callId: string;
  readonly isError: true;
  readonly kind: "subagent-result";
  readonly origin: "dispatch";
  readonly output: string;
  readonly subagentName: string;
}> {
  "use workflow";

  return {
    callId: "authored-call",
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: "authored payload",
    subagentName: "authored-name",
  };
}

export async function* reportingDeployWorkflow(
  input: DeployInput,
): AsyncGenerator<string, { readonly plan: string }> {
  "use workflow";

  const plan = await planDeployStep(input.service);
  yield `planned ${input.service}`;
  return { plan };
}

export async function* backgroundDeployWorkflow(
  input: DeployInput,
  _ctx: ToolContext,
  task: TaskExec,
): AsyncGenerator<string | TaskMessage | TaskSetState, { readonly plan: string }> {
  "use workflow";

  const plan = await planDeployStep(input.service);
  yield task.setState({ plan });
  yield `planned ${input.service}`;
  yield task.postMessage(`Review ${plan}`);
  return { plan };
}

async function planDeployStep(service: string): Promise<string> {
  "use step";

  return `plan:${service}`;
}

export async function stepThenRaceWorkflow(
  input: DeployInput,
): Promise<{ readonly decided: string; readonly service: string }> {
  "use workflow";
  const gate = createHook<{ readonly optionId: string }>();
  await planDeployStep(input.service);
  const answer = await Promise.race([gate, workflowSleep("50ms")]);
  return { decided: answer === undefined ? "timed out" : "answered", service: input.service };
}

/** Holds in a step until `ctx.abortSignal` fires, then cleans up in `finally`. */
export async function holdUntilAbortedWorkflow(
  input: DeployInput,
  ctx: ToolContext,
): Promise<{ readonly held: boolean }> {
  "use workflow";
  try {
    await holdStep(ctx.abortSignal);
    return { held: true };
  } finally {
    await releaseStep(input.service);
  }
}

async function holdStep(signal: AbortSignal): Promise<void> {
  "use step";

  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, 60_000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function releaseStep(service: string): Promise<string> {
  "use step";

  return `released ${service}`;
}

export async function askThenRaceWorkflow(
  input: DeployInput,
  ctx: ToolContext,
): Promise<{ readonly decided: string; readonly service: string }> {
  "use workflow";
  const pending = ask(ctx, {
    display: "confirmation",
    options: [
      { id: "approve", label: "Deploy", style: "primary" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Apply ${input.service}?`,
  });
  const answer = await Promise.race([pending, workflowSleep("50ms")]);
  return { decided: answer === undefined ? "timed out" : "answered", service: input.service };
}
