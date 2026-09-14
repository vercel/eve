import { describe, expect, expectTypeOf, it } from "vitest";
import { Drive, VercelSandbox } from "#public/sandbox/vercel.js";
describe("VercelSandbox", () => {
  it("creates environments", () => {
    const environment = VercelSandbox.environment({ resources: { vcpus: 4 } });
    expect(environment.provider).toBe("vercel");
    expectTypeOf(environment.create).toBeFunction();
    expectTypeOf(environment.getOrCreate).toBeFunction();
    expectTypeOf(Drive.getOrCreate).toBeFunction();
  });
});
