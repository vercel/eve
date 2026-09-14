import { describe, expect, expectTypeOf, it } from "vitest";

import { defineDefaultSandboxProvider } from "#sandbox/providers/default.js";
import { DockerSandbox, MicrosandboxSandbox, VercelSandbox } from "#sandbox/providers.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";

describe("sandbox providers", () => {
  it("implements default selection through the provider contract", () => {
    const environment = defineDefaultSandboxProvider({
      isDeployedOnVercel: () => true,
      isDockerAvailable: () => false,
      isMicrosandboxSupported: () => false,
    }).environment();
    expect(environment.provider).toBe("vercel");
  });
  it("exposes image and Dockerfile environments only for local image backends", () => {
    expect(DockerSandbox.image("example.test/agent@sha256:abc").kind).toBe("image");
    expect(DockerSandbox.dockerfile().kind).toBe("dockerfile");
    expect(MicrosandboxSandbox.image("example.test/agent@sha256:abc").kind).toBe("image");
    expect(MicrosandboxSandbox.dockerfile().kind).toBe("dockerfile");
    expect("image" in VercelSandbox).toBe(false);
    expect("dockerfile" in VercelSandbox).toBe(false);
  });

  it("rejects empty shared names", async () => {
    const environment = DockerSandbox.environment();
    await expect(environment.getOrCreate({ name: "  " })).rejects.toThrow("must be non-empty");
  });

  it("returns runtime sandboxes from both constructors", () => {
    const environment = DockerSandbox.environment();
    expectTypeOf(environment.create).returns.toEqualTypeOf<Promise<RuntimeSandboxSession>>();
    expectTypeOf(environment.getOrCreate).returns.toEqualTypeOf<Promise<RuntimeSandboxSession>>();
  });
});
