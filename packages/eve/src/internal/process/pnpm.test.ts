import { afterEach, describe, expect, it } from "vitest";

import { resolvePnpmInvocation } from "./pnpm.js";

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
});

describe("resolvePnpmInvocation", () => {
  it("runs the PATH pnpm.cmd shim through cmd without a detached shell", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const savedHome = process.env.PNPM_HOME;
    const savedExecPath = process.env.npm_execpath;
    delete process.env.PNPM_HOME;
    delete process.env.npm_execpath;

    try {
      expect(resolvePnpmInvocation(["pack"])).toEqual({
        args: ["/d", "/s", "/c", "pnpm.cmd", "pack"],
        command: process.env.ComSpec ?? "cmd.exe",
      });
    } finally {
      if (savedHome === undefined) delete process.env.PNPM_HOME;
      else process.env.PNPM_HOME = savedHome;
      if (savedExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = savedExecPath;
    }
  });
});
