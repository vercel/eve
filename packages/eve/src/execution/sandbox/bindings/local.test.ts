import { describe, expect, it } from "vitest";

import {
  createDockerSandboxProvider,
  createJustBashSandboxProvider,
  DOCKER_PROVIDER_NAME,
  JUST_BASH_PROVIDER_NAME,
} from "#execution/sandbox/bindings/local.js";

describe("local sandbox providers", () => {
  it("use distinct stable provider names", () => {
    expect(new Set([DOCKER_PROVIDER_NAME, JUST_BASH_PROVIDER_NAME, "vercel"]).size).toBe(3);
  });

  it("construct provider implementations without probing or installing", () => {
    expect(createDockerSandboxProvider({ image: "alpine:3" })).toBeDefined();
    expect(createJustBashSandboxProvider({ autoInstall: false })).toBeDefined();
  });
});
