import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { Asker, Question } from "../../ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupPhoton, type PhotonSetupDeps } from "./setup-flow.js";

function asker(answers: Record<string, string>): Asker {
  return {
    ask: async <T>(question: Question<T>) => answers[question.key] as T,
    askMany: async () => [],
  };
}

function deps(): PhotonSetupDeps {
  return {
    appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    findDedicatedLine: vi.fn(async () => undefined),
    openUrl: vi.fn(),
    provisionConnector: vi.fn(),
    provisionProject: vi.fn(async () => ({
      projectId: "project-id",
      projectSecret: "project-secret",
      cleanup: vi.fn(async () => {}),
    })),
    useProject: vi.fn(),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("Photon setup", () => {
  it("scaffolds portable credentials when Vercel Connect is unavailable", async () => {
    const fake = createFakePrompter({ single: () => "portable" });
    const effects = deps();

    await expect(
      setupPhoton({
        agentName: "agent",
        projectPath: "/project",
        environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: asker({ "photon-phone-number": "+15551234567" }),
          prompter: fake.prompter,
        }),
        deps: effects,
      }),
    ).resolves.toMatchObject({ kind: "done" });

    expect(effects.appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      IMESSAGE_PROJECT_ID: "project-id",
      IMESSAGE_PROJECT_SECRET: "project-secret",
    });
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/photon.ts",
      expect.stringContaining("IMESSAGE_WEBHOOK_SECRET"),
      { force: undefined },
    );
  });

  it("uses the agent name in the default Photon project name", async () => {
    const fake = createFakePrompter({ single: () => "portable" });
    const effects = deps();

    await setupPhoton({
      agentName: "weather-agent",
      projectPath: "/project",
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      ui: createIntegrationSetupUi({
        asker: asker({ "photon-phone-number": "+15551234567" }),
        prompter: fake.prompter,
      }),
      deps: effects,
    });

    expect(effects.provisionProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: "eve · weather-agent" }),
    );
  });

  it("uses an existing dedicated project without asking for an operator number", async () => {
    const answers: ("portable" | "existing")[] = ["portable", "existing"];
    const fake = createFakePrompter({ single: () => answers.shift() ?? "existing" });
    const effects = deps();
    vi.mocked(effects.findDedicatedLine).mockResolvedValue("+15550000000");
    vi.mocked(effects.useProject).mockResolvedValue({
      projectId: "project-id",
      projectSecret: "project-secret",
      assignedPhoneNumber: "+15550000000",
      cleanup: vi.fn(async () => {}),
    });

    await expect(
      setupPhoton({
        agentName: "agent",
        projectPath: "/project",
        environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: asker({
            "photon-project-id": "project-id",
            "photon-project-secret": "project-secret",
          }),
          prompter: fake.prompter,
        }),
        deps: effects,
      }),
    ).resolves.toMatchObject({ kind: "done", assignedPhoneNumber: "+15550000000" });

    expect(effects.useProject).toHaveBeenCalledWith({
      projectId: "project-id",
      projectSecret: "project-secret",
      dedicatedLine: "+15550000000",
      phoneNumber: undefined,
    });
  });

  it("requires Vercel login when Connect is selected without an authenticated CLI", async () => {
    const fake = createFakePrompter({ single: () => "vercel" });

    await expect(
      setupPhoton({
        agentName: "agent",
        projectPath: "/project",
        environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({ asker: asker({}), prompter: fake.prompter }),
        deps: deps(),
      }),
    ).rejects.toThrow("vercel login");
  });
});
