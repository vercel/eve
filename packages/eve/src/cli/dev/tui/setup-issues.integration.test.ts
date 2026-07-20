import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Client, type AgentInfoResult } from "#client/index.js";

import { EveTUIRunner, type AgentTUIRenderer } from "./runner.js";
import { detectSetupIssues } from "./setup-issues.js";
import { createFakeSetupFlowRenderer } from "./test/fake-setup-flow-renderer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const DISCONNECTED_GATEWAY_INFO: AgentInfoResult = {
  agent: {
    agentRoot: "/app/agent",
    appRoot: "/app",
    model: {
      endpoint: { kind: "gateway", connected: false },
      id: "openai/gpt-5.5",
      routing: { kind: "gateway", target: "openai" },
    },
    name: "Agent",
  },
  capabilities: { devRoutes: true },
  channels: { authored: [], available: [], disabledFramework: [], framework: [] },
  connections: [],
  diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
  hooks: [],
  instructions: { dynamic: [], static: null },
  kind: "eve-agent-info",
  mode: "development",
  sandbox: null,
  schedules: [],
  skills: { dynamic: [], static: [] },
  subagents: { local: [], total: 0 },
  tools: {
    authored: [],
    available: [],
    disabledFramework: [],
    dynamic: [],
    framework: [],
    reserved: [],
  },
  version: 1,
  workflow: { enabled: false, toolName: "Workflow" },
  workspace: { resourceRoot: null, rootEntries: [] },
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
    const handle = vi.fn(async () => {
      order.push("model");
      return { message: "/model cancelled." };
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
      session: client.session(),
      initialInput: "/model",
    });

    await runner.run();

    expect(handle).toHaveBeenCalledExactlyOnceWith(
      { type: "extension", name: "model", argument: "" },
      { renderer, title: "eve", initialModelStep: "provider" },
    );
    expect(readPrompt).toHaveBeenCalledOnce();
    expect(order).toEqual(["model", "prompt"]);
  });
});
