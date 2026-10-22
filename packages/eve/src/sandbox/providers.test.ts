import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { DockerSandbox, VercelSandbox } from "#sandbox/providers.js";
import type { RuntimeSandboxSessionFor } from "#shared/sandbox-session.js";

describe("sandbox providers", () => {
  it("exposes image and Dockerfile constructors only for local image providers", () => {
    expect(DockerSandbox.image("example.test/agent@sha256:abc").provider).toBe("docker");
    expect(DockerSandbox.dockerfile().provider).toBe("docker");
    expect("image" in VercelSandbox).toBe(false);
    expect("dockerfile" in VercelSandbox).toBe(false);
  });

  it("returns runtime sandboxes from open", () => {
    const environment = DockerSandbox.environment({});
    expectTypeOf(environment.open).returns.toEqualTypeOf<
      Promise<RuntimeSandboxSessionFor<DockerSandboxSession>>
    >();
  });
});
