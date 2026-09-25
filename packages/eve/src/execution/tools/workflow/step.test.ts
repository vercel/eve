import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { workflowToolStep } from "#execution/tools/workflow/step.js";

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
