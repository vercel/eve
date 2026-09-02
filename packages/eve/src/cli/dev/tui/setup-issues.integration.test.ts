import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Client, type AgentInfoResult } from "#client/index.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";

import { EveTUIRunner, type AgentTUIRenderer } from "./runner.js";
import { detectSetupIssues } from "./setup-issues.js";
import { createFakeSetupFlowRenderer } from "./test/fake-setup-flow-renderer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE_GATEWAY_INFO = createTestAgentInfoResult({
  agentRoot: "/app/agent",
  appRoot: "/app",
  modelId: "openai/gpt-5.5",
  name: "Agent",
});
const DISCONNECTED_GATEWAY_INFO: AgentInfoResult = {
  ...BASE_GATEWAY_INFO,
  agent: {
    ...BASE_GATEWAY_INFO.agent,
    model: {
      endpoint: { kind: "gateway", connected: false },
      id: "openai/gpt-5.5",
      routing: { kind: "gateway", target: "openai" },
    },
  },
};

async function linkedAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-boot-detect-"));
  await mkdir(join(appRoot, ".vercel"), { recursive: true });
  await writeFile(join(appRoot, ".vercel", "project.json"), "{}", "utf8");
  return appRoot;
}

describe("BOOT_DETECTIONS against a real directory", () => {
  it("stays quiet when a compiled gateway model has a credential present", async () => {
    const appRoot = await linkedAppRoot();
    const issues = await detectSetupIssues({
      appRoot,
      env: { AI_GATEWAY_API_KEY: "k" },
      info: DISCONNECTED_GATEWAY_INFO,
    });
    expect(issues).toEqual([]);
  });

  it("diagnoses missing credentials (not the link) when the directory is linked", async () => {
    const appRoot = await linkedAppRoot();
    const issues = await detectSetupIssues({ appRoot, env: {} });
    expect(issues).toEqual([
      { kind: "attention", label: "AI Gateway credentials missing", command: "/model" },
    ]);
  });

  it("diagnoses a linked project with disconnected model access", async () => {
    const appRoot = await linkedAppRoot();
    const issues = await detectSetupIssues({
      appRoot,
      env: {},
      info: DISCONNECTED_GATEWAY_INFO,
    });

    expect(issues).toEqual([
      {
        kind: "attention",
        label: "AI Gateway credentials missing",
        command: "/model",
      },
    ]);
  });

  it("opens model setup from the prefilled onboarding prompt when inspection is unavailable", async () => {
    const appRoot = await linkedAppRoot();
    const client = new Client({ host: "http://localhost:3000" });
    vi.spyOn(client, "info").mockRejectedValue(new Error("inspection unavailable"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ revision: "snapshot-a" })),
    );
    const order: string[] = [];
    const handle = vi.fn(async (command: { name: string }) => {
      order.push(command.name);
      return { message: `/${command.name} dismissed.` };
    });
    const readPrompt = vi.fn(async () => {
      order.push("prompt");
      return undefined;
    });
    const renderer: AgentTUIRenderer = {
      readPrompt,
      renderStream: vi.fn(async () => {}),
      setupFlow: createFakeSetupFlowRenderer(),
    };
    const runner = new EveTUIRunner({
      appRoot,
      client,
      detectProjectIdentity: vi.fn(async () => undefined),
      getVercelAuthStatus: vi.fn(async (): Promise<"authenticated"> => "authenticated"),
      promptCommandHandler: { handle },
      renderer,
      serverUrl: "http://localhost:3000",
      session: client.sessions.attach("session_test"),
      onboard: true,
    });

    await runner.run();

    expect(handle).toHaveBeenNthCalledWith(
      1,
      { type: "extension", name: "model", argument: "" },
      expect.objectContaining({
        renderer,
        title: "eve",
        initialModelStep: "provider",
        keepSetupFlowOpen: true,
        setupFlowTitle: "Set up eve",
        setupFlowNavigation: {
          kind: "planner",
          activeStep: 0,
          firstNavigableStep: 1,
          steps: [
            { label: "Model", complete: false },
            { label: "Channels" },
            { label: "Integrations" },
            { label: "Review" },
          ],
        },
      }),
    );
    expect(handle).toHaveBeenNthCalledWith(
      2,
      { type: "extension", name: "add", argument: "" },
      expect.objectContaining({
        renderer,
        title: "eve",
        keepSetupFlowOpen: true,
        setupFlowTitle: "Set up eve",
        registryPlannerContext: {
          prefixSteps: [{ label: "Model", complete: true }],
          reviewMessage: "Review your agent",
          primaryActionLabel: "Install and finish setup",
          emptyActionLabel: "Finish setup",
        },
      }),
    );
    expect(readPrompt).toHaveBeenCalledOnce();
    expect(order).toEqual(["model", "add", "prompt"]);
  });
});
