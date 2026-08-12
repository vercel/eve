import { afterEach, expect, it, vi } from "vitest";

const workflowWorldResolverKey = Symbol.for("@workflow/world//getWorldFn");
const globalSymbols = globalThis as typeof globalThis & Record<symbol, unknown>;
const existingWorkflowWorldResolver = globalSymbols[workflowWorldResolverKey];

afterEach(() => {
  if (existingWorkflowWorldResolver === undefined) {
    Reflect.deleteProperty(globalSymbols, workflowWorldResolverKey);
  } else {
    globalSymbols[workflowWorldResolverKey] = existingWorkflowWorldResolver;
  }
});

it("does not initialize a Workflow World resolver when imported", async () => {
  Reflect.deleteProperty(globalSymbols, workflowWorldResolverKey);
  vi.resetModules();

  await import("./index.js");

  expect(globalSymbols[workflowWorldResolverKey]).toBeUndefined();
});
