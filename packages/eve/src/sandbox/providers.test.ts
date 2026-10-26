import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { DefaultSandbox, DockerSandbox, VercelSandbox } from "#sandbox/providers.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";

describe("sandbox providers", () => {
  it("exposes image and Dockerfile constructors only for local image providers", () => {
    expect(DockerSandbox.image("example.test/agent@sha256:abc").provider).toBe("docker");
    expect(DockerSandbox.dockerfile().provider).toBe("docker");
    expect("image" in VercelSandbox).toBe(false);
    expect("dockerfile" in VercelSandbox).toBe(false);
  });

  it("rejects SDK-specific options on the default fallback with migration guidance", () => {
    expect(() =>
      DefaultSandbox.environment({
        justBash: {
          // @ts-expect-error SDK customization belongs to the explicit provider.
          customCommands: [],
        },
      }),
    ).toThrow("Use JustBashSandbox.environment()");
  });

  it("returns runtime sandboxes from open", () => {
    const environment = DockerSandbox.environment({});
    expectTypeOf(environment.open).returns.toEqualTypeOf<
      Promise<RuntimeSandboxSession<DockerSandboxSession>>
    >();
  });
});
