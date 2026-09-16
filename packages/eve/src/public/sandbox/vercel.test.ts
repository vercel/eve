import { describe, expect, expectTypeOf, it } from "vitest";
import {
  Drive,
  ExperimentalVercelDockerfile,
  ExperimentalVercelReusedDockerfile,
  VercelSandbox,
} from "#public/sandbox/vercel.js";
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
    expectTypeOf(environment.open).toBeFunction();
  });

  it("creates experimental reused Dockerfile environments", () => {
    const environment = ExperimentalVercelReusedDockerfile.environment({
      key: "trusted-team",
      networkPolicy: "deny-all",
      region: "iad1",
    });
    expect(environment.provider).toBe("vercel-reused-image");
    expect(environment.kind).toBe("dockerfile");
    expectTypeOf(environment.open).parameters.toEqualTypeOf<[]>();
  });
});
