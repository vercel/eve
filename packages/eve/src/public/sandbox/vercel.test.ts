import { describe, expect, expectTypeOf, it } from "vitest";
import type { SessionContext } from "#context/session-context.js";
import type { RuntimeSandboxSessionFor } from "#public/definitions/sandbox.js";
import type { NetworkPolicySandboxSession } from "#shared/sandbox-session.js";
import { Drive, VercelSandbox } from "#public/sandbox/vercel.js";
describe("VercelSandbox", () => {
  it("creates environments", () => {
    const environment = VercelSandbox.environment({ resources: { vcpus: 4 } });
    expect(environment.provider).toBe("vercel");
    expectTypeOf(environment.open).toBeFunction();
    expectTypeOf(Drive.getOrCreate).toBeFunction();
  });

  it("preserves its session capabilities through getSandbox", () => {
    const environment = VercelSandbox.environment();
    const assertTypes = (ctx: SessionContext) => {
      expectTypeOf(ctx.getSandbox(environment)).toEqualTypeOf<
        Promise<RuntimeSandboxSessionFor<NetworkPolicySandboxSession>>
      >();
    };

    expectTypeOf(assertTypes).toBeFunction();
  });
});
