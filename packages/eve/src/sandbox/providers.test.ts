import type { NetworkPolicySandboxSession } from "#public/sandbox/network-policy-session.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { defineDefaultSandboxProvider } from "#sandbox/providers/default.js";
import { DockerSandbox, MicrosandboxSandbox, VercelSandbox } from "#sandbox/providers.js";
import type { RuntimeSandboxSessionFor } from "#shared/sandbox-session.js";

describe("sandbox providers", () => {
  it("implements default selection through the provider contract", () => {
    const environment = defineDefaultSandboxProvider({
      isDeployedOnVercel: () => true,
      isDockerAvailable: () => false,
      isMicrosandboxSupported: () => false,
    }).environment();
    expect(environment.provider).toBe("vercel");
  });
  it("exposes image and Dockerfile constructors only for local image providers", () => {
    expect(DockerSandbox.image("example.test/agent@sha256:abc").provider).toBe("docker");
    expect(DockerSandbox.dockerfile().provider).toBe("docker");
    expect(MicrosandboxSandbox.image("example.test/agent@sha256:abc").provider).toBe(
      "microsandbox",
    );
    expect(MicrosandboxSandbox.dockerfile().provider).toBe("microsandbox");
    expect("image" in VercelSandbox).toBe(false);
    expect("dockerfile" in VercelSandbox).toBe(false);
  });

  it("returns runtime sandboxes from open", () => {
    const environment = DockerSandbox.environment();
    expectTypeOf(environment.open).returns.toEqualTypeOf<
      Promise<RuntimeSandboxSessionFor<NetworkPolicySandboxSession>>
    >();
  });
});
