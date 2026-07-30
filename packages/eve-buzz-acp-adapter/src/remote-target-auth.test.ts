import { describe, expect, it, vi } from "vitest";
import { createHeadlessPrompter } from "eve/setup";
import { readEveTargetInfo, VercelDeploymentProtectionError } from "./eve-target.js";
import { readInstallTargetInfo } from "./remote-target-auth.js";

const prompter = createHeadlessPrompter(vi.fn());

describe("remote install authentication", () => {
  it("configures Vercel authentication and retains only the verified scope", async () => {
    const readTarget = vi
      .fn<typeof readEveTargetInfo>()
      .mockRejectedValueOnce(new VercelDeploymentProtectionError())
      .mockResolvedValueOnce({ modelId: "anthropic/claude-sonnet-5", name: "weather-agent" });
    const authenticate = vi.fn(async () => ({
      kind: "prepared" as const,
      target: { deployment: { ownerId: "team_example" } },
      resolveToken: async () => "oidc-token",
    }));

    await expect(
      readInstallTargetInfo({
        cwd: "/workspace",
        eveBin: "/eve",
        prompter,
        target: { kind: "remote", url: "https://agent.example.com" },
        dependencies: {
          readEveTargetInfo: readTarget,
          runRemoteAuthFlow: authenticate,
        },
      }),
    ).resolves.toEqual({
      info: { modelId: "anthropic/claude-sonnet-5", name: "weather-agent" },
      vercelScope: "team_example",
    });

    expect(authenticate).toHaveBeenCalledWith({
      configureTrustedSources: true,
      prompter,
      serverUrl: "https://agent.example.com",
      workspaceRoot: "/workspace",
    });
    expect(readTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: {
          authorization: "Bearer oidc-token",
          "x-vercel-trusted-oidc-idp-token": "oidc-token",
        },
      }),
    );
  });

  it("requires an interactive flow when no bypass credential is available", async () => {
    await expect(
      readInstallTargetInfo({
        cwd: "/workspace",
        eveBin: "/eve",
        target: { kind: "remote", url: "https://agent.example.com" },
        dependencies: {
          readEveTargetInfo: vi
            .fn<typeof readEveTargetInfo>()
            .mockRejectedValue(new VercelDeploymentProtectionError()),
        },
      }),
    ).rejects.toThrow("Run the installer interactively");
  });
});
