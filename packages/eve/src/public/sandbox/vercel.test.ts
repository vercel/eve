import { describe, expect, expectTypeOf, it } from "vitest";

import type { SessionContext } from "#context/session-context.js";
import type { RuntimeSandboxSessionFor } from "#public/definitions/sandbox.js";
import {
  Drive,
  ExperimentalVercelDockerfile,
  VercelSandbox,
  type VercelSandboxSession,
} from "#public/sandbox/vercel.js";

describe("VercelSandbox", () => {
  it("creates environments", () => {
    const environment = VercelSandbox.environment({ resources: { vcpus: 4 } });
    expect(environment.provider).toBe("vercel");
    expectTypeOf(environment.open).toBeFunction();
    expectTypeOf(Drive.getOrCreate).toBeFunction();
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

  it("creates experimental Dockerfile image environments", () => {
    const environment = ExperimentalVercelDockerfile.environment({ region: "iad1" });
    expect(environment.provider).toBe("vercel-image");
    expectTypeOf(environment.open).toBeFunction();
    // @ts-expect-error Immutable setup belongs in the Dockerfile for this environment.
    ExperimentalVercelDockerfile.environment({ prepare: async () => {} });
  });
});
