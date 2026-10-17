import { describe, expect, expectTypeOf, it } from "vitest";
import type { SessionContext } from "#context/session-context.js";
import type { RuntimeSandboxSession } from "#public/definitions/sandbox.js";
import { VercelSandbox, type VercelSandboxSession } from "#public/sandbox/vercel.js";
describe("VercelSandbox", () => {
  it("creates environments", () => {
    const environment = VercelSandbox.environment({ resources: { vcpus: 4 } });
    expect(environment.provider).toBe("vercel");
    expectTypeOf(environment.open).toBeFunction();
  });

  it("preserves its session capabilities through getSandbox", () => {
    const environment = VercelSandbox.environment({});
    const assertTypes = (ctx: SessionContext) => {
      expectTypeOf(ctx.getSandbox(environment)).toEqualTypeOf<
        Promise<RuntimeSandboxSession<VercelSandboxSession>>
      >();
    };

    expectTypeOf(assertTypes).toBeFunction();
  });
});
