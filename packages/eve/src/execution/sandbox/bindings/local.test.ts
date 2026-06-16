import { describe, expect, it } from "vitest";

import {
  createDockerSandboxBackend,
  createJustBashSandboxBackend,
  createMicrosandboxSandboxBackend,
  DOCKER_BACKEND_NAME,
  JUST_BASH_BACKEND_NAME,
  MICROSANDBOX_BACKEND_NAME,
} from "#execution/sandbox/bindings/local.js";

describe("local sandbox backend factories", () => {
  it("expose distinct stable backend names", () => {
    // Backend names participate in template/session key derivation and
    // persisted reconnect state, so the engines must never collide.
    expect(createDockerSandboxBackend().name).toBe(DOCKER_BACKEND_NAME);
    expect(createJustBashSandboxBackend().name).toBe(JUST_BASH_BACKEND_NAME);
    expect(createMicrosandboxSandboxBackend().name).toBe(MICROSANDBOX_BACKEND_NAME);
    expect(
      new Set([DOCKER_BACKEND_NAME, JUST_BASH_BACKEND_NAME, MICROSANDBOX_BACKEND_NAME, "vercel"])
        .size,
    ).toBe(4);
  });

  it("constructing a backend performs no environment probing or installs", () => {
    // Construction must stay side-effect free: probing and installs are
    // deferred to first use so `defineSandbox` evaluation (including at
    // compile time) stays cheap on any host.
    expect(createDockerSandboxBackend({ createOptions: { image: "alpine:3" } }).name).toBe(
      "docker",
    );
    expect(createMicrosandboxSandboxBackend({ createOptions: { cpus: 2 } }).name).toBe(
      "microsandbox",
    );
    expect(createJustBashSandboxBackend({ createOptions: { autoInstall: false } }).name).toBe(
      "just-bash",
    );
  });
});
