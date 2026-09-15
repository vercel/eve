import { describe, expect, expectTypeOf, it } from "vitest";
import { Drive, ExperimentalVercelDockerfile, VercelSandbox } from "#public/sandbox/vercel.js";
describe("VercelSandbox", () => {
  it("creates environments", () => {
    const environment = VercelSandbox.environment({ resources: { vcpus: 4 } });
    expect(environment.provider).toBe("vercel");
    expectTypeOf(environment.open).toBeFunction();
    expectTypeOf(Drive.getOrCreate).toBeFunction();
  });

  it("creates experimental Dockerfile image environments", () => {
    const environment = ExperimentalVercelDockerfile.environment({ region: "iad1" });
    expect(environment.provider).toBe("vercel-image");
    expect(environment.kind).toBe("dockerfile");
    expectTypeOf(environment.create).toBeFunction();
    expectTypeOf(environment.getOrCreate).toBeFunction();
    // @ts-expect-error Immutable setup belongs in the Dockerfile for this environment.
    ExperimentalVercelDockerfile.environment({ prepare: async () => {} });
  });
});
