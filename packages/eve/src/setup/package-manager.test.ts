import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectInvokingPackageManager,
  packageManagerFromUserAgent,
  resolvePackageManager,
} from "./package-manager.js";

describe("resolvePackageManager", () => {
  it("prefers the packageManager field over lockfiles", () => {
    expect(
      resolvePackageManager({
        packageManagerField: "yarn@4.5.0",
        lockfiles: ["pnpm-lock.yaml"],
      }),
    ).toEqual({ kind: "yarn", source: "package-manager-field" });
  });

  it("ignores an unknown packageManager field and falls back to lockfiles", () => {
    expect(
      resolvePackageManager({
        packageManagerField: "vlt@1.0.0",
        lockfiles: ["package-lock.json"],
      }),
    ).toEqual({ kind: "npm", source: "lockfile" });
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const)("maps %s to %s", (lockfile, kind) => {
    expect(resolvePackageManager({ lockfiles: [lockfile] })).toEqual({
      kind,
      source: "lockfile",
    });
  });

  it("resolves competing lockfiles in precedence order, pnpm first", () => {
    expect(resolvePackageManager({ lockfiles: ["yarn.lock", "pnpm-lock.yaml"] })).toEqual({
      kind: "pnpm",
      source: "lockfile",
    });
  });

  it("defaults to pnpm when nothing identifies a manager", () => {
    expect(resolvePackageManager({ lockfiles: [] })).toEqual({
      kind: "pnpm",
      source: "default",
    });
  });
});

describe("packageManagerFromUserAgent", () => {
  it.each([
    ["pnpm/10.4.0 npm/? node/v24.0.0 darwin arm64", "pnpm"],
    ["npm/11.0.0 node/v24.0.0 darwin arm64 workspaces/false", "npm"],
    ["yarn/1.22.22 npm/? node/v24.0.0 darwin arm64", "yarn"],
    ["bun/1.2.0 npm/? node/v24.0.0 darwin arm64", "bun"],
  ] as const)("identifies %j as %s", (userAgent, kind) => {
    expect(packageManagerFromUserAgent(userAgent)).toBe(kind);
  });

  it.each([undefined, "", "vlt/1.0.0 node/v24.0.0 darwin arm64"])(
    "yields undefined for absent or unknown user agent %j",
    (userAgent) => {
      expect(packageManagerFromUserAgent(userAgent)).toBeUndefined();
    },
  );
});

describe("detectInvokingPackageManager", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the launching manager from npm_config_user_agent", () => {
    vi.stubEnv("npm_config_user_agent", "yarn/1.22.22 npm/? node/v24.0.0 darwin arm64");
    expect(detectInvokingPackageManager()).toBe("yarn");
  });

  it("yields undefined when the variable is unset", () => {
    vi.stubEnv("npm_config_user_agent", undefined);
    expect(detectInvokingPackageManager()).toBeUndefined();
  });
});
