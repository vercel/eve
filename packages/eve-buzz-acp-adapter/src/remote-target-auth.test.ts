import { describe, expect, it, vi } from "vitest";
import type { AgentInfoResult } from "eve/client";
import { createHeadlessPrompter } from "eve/setup";
import { readEveTargetInfo } from "./eve-target.js";
import { readInstallTargetInfo } from "./remote-target-auth.js";

const prompter = createHeadlessPrompter(vi.fn());
const remoteInfo = {
  agent: { model: { id: "anthropic/claude-sonnet-5" }, name: "weather-agent" },
} as AgentInfoResult;

describe("remote install authentication", () => {
  it("uses verified remote inspection and retains only the verified scope", async () => {
    const inspect = vi.fn(async () => ({ info: remoteInfo, vercelScope: "team_example" }));

    await expect(
      readInstallTargetInfo({
        cwd: "/workspace",
        eveBin: "/eve",
        prompter,
        target: { kind: "remote", url: "https://agent.example.com" },
        dependencies: { inspectVerifiedRemoteAgent: inspect },
      }),
    ).resolves.toEqual({
      info: { modelId: "anthropic/claude-sonnet-5", name: "weather-agent" },
      vercelScope: "team_example",
    });

    expect(inspect).toHaveBeenCalledWith({
      prompter,
      serverUrl: "https://agent.example.com",
      workspaceRoot: "/workspace",
    });
  });

  it("does not use remote authentication for a local target", async () => {
    const inspect = vi.fn();
    const readTarget = vi
      .fn<typeof readEveTargetInfo>()
      .mockResolvedValue({ modelId: "openai/gpt-5.5", name: "local-agent" });

    await expect(
      readInstallTargetInfo({
        cwd: "/workspace",
        eveBin: "/eve",
        target: { kind: "local", directory: "/workspace/agent" },
        dependencies: {
          inspectVerifiedRemoteAgent: inspect,
          readEveTargetInfo: readTarget,
        },
      }),
    ).resolves.toEqual({
      info: { modelId: "openai/gpt-5.5", name: "local-agent" },
    });
    expect(inspect).not.toHaveBeenCalled();
  });
});
