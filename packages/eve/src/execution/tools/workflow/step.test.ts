import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { WorkflowStepInvocation } from "#execution/tools/workflow/step-context.js";
import { workflowToolStep } from "#execution/tools/workflow/step.js";
import type { ToolContext } from "#tools/definition.js";

// A workflow body's hooks and metadata, outside a workflow: each hook under the token it asks for.
vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  createHook: (options?: { readonly token?: string }) => ({
    dispose: () => {},
    token: options?.token ?? "unnamed",
  }),
  getWorkflowMetadata: () => ({ url: "https://agent.example" }),
}));

it("preserves native arguments and receivers for calls without workflow context", async () => {
  const original = vi.fn(async function (this: { prefix: string }, value: string) {
    return `${this.prefix}:${value}`;
  });
  const authorize = vi.fn();
  const wrapped = workflowToolStep(original as (...args: unknown[]) => Promise<unknown>, authorize);
  await expect(wrapped.call({ prefix: "native" }, "argument")).resolves.toBe("native:argument");
  expect(authorize).not.toHaveBeenCalled();
  expect(original).toHaveBeenCalledWith("argument");
});

it("preserves the SDK step reference and bind metadata through serialization", async () => {
  const sdk = dirname(createRequire(import.meta.url).resolve("@workflow/core"));
  const { createUseStep } = await import(pathToFileURL(resolve(sdk, "step.js")).href);
  const { getStepFunctionReducer } = await import(
    pathToFileURL(resolve(sdk, "serialization/reducers/step-function-vm.js")).href
  );
  const original = createUseStep({})("step//./steps//read");
  const wrapped = workflowToolStep(original, vi.fn());
  const reduce = getStepFunctionReducer().StepFunction;
  expect(reduce(wrapped)).toEqual(reduce(original));
  const receiver = { service: "api" };
  expect(reduce(wrapped.bind(receiver, "argument"))).toEqual({
    stepId: original.stepId,
    boundThis: receiver,
    boundArgs: ["argument"],
  });
});

it("gives a step a sign-in hook under a token the connection callback route delivers to", async () => {
  const ctx = {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    toolName: "deploy",
  } as ToolContext;
  attachWorkflowToolRunContext(ctx, {
    agentContext: { bundle: { source: {} }, sandbox: { sessionId: "session" } },
  } as never);
  const execute = vi.fn(async (_invocation: WorkflowStepInvocation) => ({
    authorized: [],
    kind: "result",
    output: "deployed",
  }));
  const step = workflowToolStep(vi.fn(), execute);

  await expect(step("api", ctx)).resolves.toBe("deployed");

  // The step puts this token in each sign-in's callback URL.
  expect(execute.mock.calls[0]?.[0].context.token).toMatch(/^eve:sign-in:v1:[0-9a-f-]{36}$/);
});
