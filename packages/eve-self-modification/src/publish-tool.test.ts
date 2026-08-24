import type { DeploymentSource } from "eve";
import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

const getDeploymentSource = vi.hoisted(() =>
  vi.fn<() => DeploymentSource | null>(() => ({
    repository: "github.com/acme/agent",
    revision: "1".repeat(40),
    rootDirectory: ".",
  })),
);

vi.mock("eve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("eve")>()),
  getDeploymentSource,
}));

import {
  defineSelfModificationPublishTool,
  operationIdFromContext,
  readWorkspaceContext,
} from "../extension/tools/publish.js";

const pullRequests = {
  repository: { owner: "acme", targetBranch: "main", repo: "agent" },
};

afterEach(() => vi.unstubAllEnvs());

async function resolvePublishTool(publish: ReturnType<typeof defineSelfModificationPublishTool>) {
  return publish.events["session.started"]?.({}, {} as never);
}

describe("self-modification publish tool", () => {
  it("is absent without pull request configuration", async () => {
    const publish = defineSelfModificationPublishTool();

    expect(publish).toMatchObject({ kind: "eve:dynamic" });
    await expect(resolvePublishTool(publish)).resolves.toBeNull();
  });

  it("stays absent in development when pull requests are configured", async () => {
    vi.stubEnv("EVE_DEV", "1");

    await expect(
      resolvePublishTool(defineSelfModificationPublishTool(pullRequests)),
    ).resolves.toBeNull();
  });

  it("publishes without an in-session approval gate", async () => {
    const tool = await resolvePublishTool(defineSelfModificationPublishTool(pullRequests));
    if (tool === null || tool === undefined || !("execute" in tool)) {
      throw new Error("Expected configured publish tool.");
    }
    expect("approval" in tool).toBe(false);
  });

  it("rechecks deployment source before opening the sandbox", async () => {
    getDeploymentSource.mockReturnValueOnce(null);
    const tool = await resolvePublishTool(defineSelfModificationPublishTool(pullRequests));
    if (tool === null || tool === undefined || !("execute" in tool)) {
      throw new Error("Expected configured publish tool.");
    }
    const getSandbox = vi.fn(async () => {
      throw new Error("Sandbox should not be opened.");
    });
    const ctx: ToolContext = {
      abortSignal: new AbortController().signal,
      callId: "publish-call",
      getSandbox,
      getSkill() {
        throw new Error("Skill should not be loaded.");
      },
      async getToken() {
        throw new Error("Tool auth should not be used.");
      },
      requireAuth() {
        throw new Error("Tool auth should not be used.");
      },
      session: {
        auth: {
          current: {
            attributes: { role: "admin" },
            authenticator: "test",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "child-1",
        parent: {
          callId: "call-3",
          rootSessionId: "root-1",
          sessionId: "parent-2",
          turn: { id: "turn-4", sequence: 4 },
        },
        turn: { id: "child-turn", sequence: 0 },
      },
      toolName: "publish",
    };

    await expect(tool.execute({ summary: "Summary", title: "Title" }, ctx)).rejects.toThrow(
      /requires deployment source metadata/u,
    );
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("fails closed when a redeploy changes the workspace source", async () => {
    const baseSha = "2".repeat(40);
    const deployedSha = "1".repeat(40);
    const run = vi.fn(async ({ command }: { command: string }) => ({
      exitCode: 0,
      stderr: "",
      stdout: command.includes("refs/eve-self-modification/base") ? baseSha : deployedSha,
    }));

    await expect(readWorkspaceContext({ run }, "3".repeat(40), ".")).rejects.toThrow(
      /source changed/u,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("derives replay identity from the root turn and delegation call", () => {
    const ctx = {
      session: {
        parent: {
          callId: "call-3",
          rootSessionId: "root-1",
          sessionId: "parent-2",
          turn: { id: "turn-4", sequence: 4 },
        },
      },
    };

    expect(operationIdFromContext(ctx)).toBe("root-1:turn-4:call-3");
  });

  it("rejects publication outside a delegated child session", () => {
    expect(() => operationIdFromContext({ session: {} })).toThrow(/delegated child session/u);
  });
});
