/**
 * Authored workflow tool bodies for integration tests. Each exported
 * `"use workflow"` function stands in for a tool's `execute`: the test tier's
 * bundler registers them in the driver, and the harness sees the stubs the
 * client transform leaves behind, exactly as it would for an application's
 * `agent/tools/*.ts`.
 */

import {
  createHook,
  getStepMetadata,
  sleep as workflowSleep,
} from "#compiled/@workflow/core/index.js";

import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import type { TaskExec, TaskMessage } from "#tools/task.js";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";

export interface DeployInput {
  readonly service: string;
}

export async function deployServiceWorkflow(
  input: DeployInput,
  ctx: WorkflowToolContext,
): Promise<{ readonly callId: string; readonly plan: string; readonly sessionId: string }> {
  "use workflow";

  const plan = await planDeployStep(input.service);
  return { callId: ctx.callId, plan, sessionId: ctx.session.id };
}

export async function authorizedDeployWorkflow(input: DeployInput, ctx: WorkflowToolContext) {
  "use workflow";
  const plan = await planDeployStep(input.service);
  const authenticatedAs = await authorizedDeployStep(input.service, ctx);
  return { plan, authenticatedAs };
}

export async function stepReferenceWorkflow(input: DeployInput) {
  "use workflow";
  const byArgument = await returnStepReference(planDeployStep);
  const byReceiver = await returnStepReference(readServiceStep);
  return {
    argument: await byArgument.bind(undefined, input.service)(),
    receiver: await byReceiver.call({ service: input.service }),
  };
}

async function returnStepReference<T extends (...args: never[]) => Promise<string>>(step: T) {
  "use step";
  return step;
}

async function readServiceStep(this: DeployInput) {
  "use step";
  return this.service;
}

async function authorizedDeployStep(service: string, ctx: WorkflowToolContext): Promise<string> {
  "use step";
  const provider: AuthorizationDefinition = {
    principalType: "user",
    async getToken({ principal }) {
      if (service !== "preauthorized" && !(service === "retry" && getStepMetadata().attempt > 1))
        throw new ConnectionAuthorizationRequiredError("deploy");
      return { token: `secret:${principal.type === "user" ? principal.id : "app"}` };
    },
    async startAuthorization({ principal, callbackUrl }) {
      return {
        challenge: {
          url: `https://idp.example/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`,
        },
        resume: { user: principal.type === "user" ? principal.id : "app" },
      };
    },
    async completeAuthorization({ principal, callback, resume }) {
      if (service === "retry" && getStepMetadata().attempt > 1)
        throw new ConnectionAuthorizationFailedError("deploy", {
          message: "Authorization code was already exchanged.",
          retryable: false,
        });
      if (
        callback.params.code !== "approved" ||
        principal.type !== "user" ||
        (resume as { user: string }).user !== principal.id
      ) {
        throw new ConnectionAuthorizationFailedError("deploy", {
          message: "Authorization denied or principal changed.",
          retryable: false,
        });
      }
      return { token: `secret:${principal.id}` };
    },
  };
  const { token } = await ctx.getToken(provider);
  if (service === "retry" && getStepMetadata().attempt === 1)
    throw new Error("Transient service failure after sign-in.");
  if (service === "rejected") ctx.requireAuth(provider);
  return token.slice("secret:".length);
}

export async function* confirmDeployWorkflow(
  input: DeployInput,
  ctx: WorkflowToolContext,
): AsyncGenerator<string, { readonly approved: boolean; readonly service: string }> {
  "use workflow";

  const plan = await planDeployStep(input.service);
  yield "awaiting approval";
  const answer = await ctx.ask({
    display: "confirmation",
    options: [
      { id: "approve", label: "Deploy", style: "primary" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Apply ${plan}?`,
  });
  yield "approval received";
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
  _ctx: WorkflowToolContext,
  task: TaskExec,
): AsyncGenerator<string | TaskMessage, { readonly plan: string }> {
  "use workflow";

  const plan = await planDeployStep(input.service);
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
  ctx: WorkflowToolContext,
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
  ctx: WorkflowToolContext,
): Promise<{ readonly decided: string; readonly service: string }> {
  "use workflow";
  const pending = ctx.ask({
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
