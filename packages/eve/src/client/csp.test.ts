import { afterEach, expect, it, vi } from "vitest";

const RealFunction = globalThis.Function;

afterEach(() => {
  globalThis.Function = RealFunction;
});

it("builds object schemas with eve's Zod without compiling code from strings", async () => {
  const compiled: unknown[][] = [];
  globalThis.Function = new Proxy(RealFunction, {
    apply(target, thisArg, args) {
      compiled.push(args);
      return Reflect.apply(target, thisArg, args);
    },
    construct(target, args, newTarget) {
      compiled.push(args);
      return Reflect.construct(target, args, newTarget);
    },
  });
  vi.resetModules();
  const { z } = await import("#compiled/zod/index.js");

  const schema = z.object({ ok: z.literal(true), workflowId: z.string() });

  expect(schema.parse({ ok: true, workflowId: "wf_1" })).toEqual({ ok: true, workflowId: "wf_1" });
  expect(compiled).toEqual([]);
});
