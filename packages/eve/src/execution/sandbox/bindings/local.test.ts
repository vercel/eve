import { describe, expect, it } from "vitest";

import {
  createDockerSandboxProvider,
  createJustBashSandboxProvider,
  createMicrosandboxSandboxProvider,
  DOCKER_PROVIDER,
  JUST_BASH_PROVIDER,
  MICROSANDBOX_PROVIDER,
} from "#execution/sandbox/bindings/local.js";

describe("local sandbox provider factories", () => {
  it("expose distinct stable provider names", () => {
    // Provider names participate in diagnostics and persisted reconnect
    // state, so the protocols must never collide.
    expect(
      new Set([DOCKER_PROVIDER, JUST_BASH_PROVIDER, MICROSANDBOX_PROVIDER, "vercel"]).size,
    ).toBe(4);
  });

  it("constructing a provider performs no environment probing or installs", () => {
    // Construction must stay side-effect free: probing and installs are
    // deferred to first use so `defineSandbox` evaluation (including at
    // compile time) stays cheap on any host.
    expect(createDockerSandboxProvider({ createOptions: { image: "alpine:3" } })).toMatchObject({
      create: expect.any(Function),
      prewarm: expect.any(Function),
    });
    expect(createMicrosandboxSandboxProvider({ createOptions: { cpus: 2 } })).toMatchObject({
      create: expect.any(Function),
      prewarm: expect.any(Function),
    });
    expect(createJustBashSandboxProvider({ createOptions: { autoInstall: false } })).toMatchObject({
      create: expect.any(Function),
      prewarm: expect.any(Function),
    });
  });
});
