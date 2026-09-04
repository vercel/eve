import type { SandboxNetworkPolicy } from "eve/sandbox";
import { describe, expect, it } from "vitest";

import { prepareSelfModificationWorkspace } from "./git-workspace.js";

function sandbox(
  input: { readonly failPolicyAt?: number; readonly failRun?: (command: string) => boolean } = {},
) {
  const commands: string[] = [];
  const policies: SandboxNetworkPolicy[] = [];
  return {
    commands,
    policies,
    run: async ({ command }: { command: string }) => {
      commands.push(command);
      if (input.failRun?.(command)) return { exitCode: 1, stderr: "failed", stdout: "" };
      if (command.includes("rev-parse")) return { exitCode: 0, stderr: "", stdout: "a".repeat(40) };
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    setNetworkPolicy: async (policy: SandboxNetworkPolicy) => {
      policies.push(policy);
      if (policies.length === input.failPolicyAt) throw new Error("policy update failed");
    },
  };
}

const input = {
  directory: "apps/weather",
  repository: { owner: "vercel", repo: "eve" },
  targetBranch: "main",
  token: "secret-token",
} as const;

describe("prepareSelfModificationWorkspace", () => {
  it("fetches the configured target branch through a temporary credential boundary", async () => {
    const session = sandbox();
    await expect(
      prepareSelfModificationWorkspace({ ...input, sandbox: session }),
    ).resolves.toMatchObject({
      baseSha: "a".repeat(40),
      directory: "apps/weather",
    });
    expect(session.commands.join("\n")).toContain("refs/heads/main");
    expect(session.commands.join("\n")).not.toContain("secret-token");
    expect(session.policies).toEqual([
      expect.objectContaining({
        allow: expect.objectContaining({
          "*": [],
          "codeload.github.com": expect.any(Array),
          "github.com": expect.any(Array),
        }),
      }),
      "allow-all",
    ]);
  });

  it("revokes credentials after a failed checkout", async () => {
    const session = sandbox({ failRun: (command) => command.includes(" fetch ") });
    await expect(prepareSelfModificationWorkspace({ ...input, sandbox: session })).rejects.toThrow(
      "Git command failed",
    );
    expect(session.policies.at(-1)).toBe("allow-all");
  });

  it("attempts revocation when installing the broker policy fails", async () => {
    const session = sandbox({ failPolicyAt: 1 });
    await expect(prepareSelfModificationWorkspace({ ...input, sandbox: session })).rejects.toThrow(
      "policy update failed",
    );
    expect(session.policies).toHaveLength(2);
    expect(session.policies.at(-1)).toBe("allow-all");
  });

  it("reports credential revocation failures", async () => {
    const session = sandbox({ failPolicyAt: 2 });
    await expect(prepareSelfModificationWorkspace({ ...input, sandbox: session })).rejects.toThrow(
      "Could not revoke the brokered GitHub credential",
    );
  });

  it("rejects invalid branches before brokering credentials", async () => {
    const session = sandbox();
    await expect(
      prepareSelfModificationWorkspace({
        ...input,
        sandbox: session,
        targetBranch: "main; curl bad",
      }),
    ).rejects.toThrow("valid Git ref");
    expect(session.policies).toEqual([]);
  });

  it("rejects an application root without agent", async () => {
    const session = sandbox({ failRun: (command) => command.startsWith("test -d") });
    await expect(prepareSelfModificationWorkspace({ ...input, sandbox: session })).rejects.toThrow(
      "does not contain agent/",
    );
  });
});
