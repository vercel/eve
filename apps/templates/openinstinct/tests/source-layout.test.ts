import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function directories(directory: string) {
  return readdirSync(directory)
    .filter((entry) => statSync(join(directory, entry)).isDirectory())
    .toSorted();
}

function files(directory: string) {
  return readdirSync(directory)
    .filter((entry) => statSync(join(directory, entry)).isFile())
    .toSorted();
}

describe("source layout", () => {
  it("keeps the Eve agent and Next route tree at the repository root", () => {
    expect(existsSync("agent/agent.ts")).toBe(true);
    expect(existsSync("agent/instructions.md")).toBe(true);
    expect(existsSync("app/layout.tsx")).toBe(true);
    expect(existsSync("app/(authenticated)/(workspace)/page.tsx")).toBe(true);
    expect(existsSync("app/(authenticated)/chat/(new)/page.tsx")).toBe(true);
    expect(existsSync("proxy.ts")).toBe(true);
    expect(existsSync("src")).toBe(false);
  });

  it("keeps browser support and cross-boundary contracts explicitly owned", () => {
    expect(directories("web")).toEqual([
      "auth",
      "browser",
      "components",
      "hooks",
      "trpc",
    ]);
    expect(files("web")).toEqual([]);
    expect(directories("shared")).toEqual([
      "browser",
      "chat",
      "environment",
      "google-workspace",
      "identity",
      "schedules",
      "user-profile",
      "vault",
      "workstreams",
    ]);
    expect(files("shared")).toEqual([]);
    expect(existsSync("shared/environment/env.ts")).toBe(true);
    expect(existsSync("agent/subagents/browser-agent/lib/kernel.ts")).toBe(
      true
    );
    expect(existsSync("db/services/installation-secrets.ts")).toBe(true);
    expect(existsSync("evals/browser/worker-events.ts")).toBe(true);
  });
});
