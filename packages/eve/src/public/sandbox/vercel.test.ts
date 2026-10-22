import { describe, expect, expectTypeOf, it } from "vitest";
import type { Drive } from "#compiled/@vercel/sandbox/index.js";
import type { SessionContext } from "#context/session-context.js";
import type { RuntimeSandboxSessionFor } from "#public/definitions/sandbox.js";
import {
  VercelSandbox,
  type VercelSandboxMount,
  type VercelSandboxSession,
} from "#public/sandbox/vercel.js";
describe("VercelSandbox", () => {
  it("creates environments", () => {
    const environment = VercelSandbox.environment({
      prepare: async (sandbox) => {
        expectTypeOf(sandbox).toExtend<VercelSandboxSession>();
      },
      resources: { vcpus: 4 },
    });
    expect(environment.provider).toBe("vercel");
    expectTypeOf(environment.open).toBeFunction();
  });

  it("accepts the Sandbox SDK's Drive and its snapshot reference as mounts", () => {
    expectTypeOf<Drive>().toExtend<VercelSandboxMount>();
    expectTypeOf<ReturnType<Drive["snapshot"]>>().toExtend<VercelSandboxMount>();
  });

  it("preserves its session capabilities through getSandbox", () => {
    const environment = VercelSandbox.environment({});
    const assertTypes = (ctx: SessionContext) => {
      expectTypeOf(ctx.getSandbox(environment)).toEqualTypeOf<
        Promise<RuntimeSandboxSessionFor<VercelSandboxSession>>
      >();
    };

    expectTypeOf(assertTypes).toBeFunction();
  });
});
