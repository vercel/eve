import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { Asker, Question } from "./ask.js";
import { photonSetupEnvironment } from "./photon-setup-environment.js";
import type { PhotonSetupDeps } from "./photon-setup.js";
import { PHOTON_CHANNEL_SETUP } from "./photon-setup.js";
import { createPhotonSetupUi } from "./photon-setup-ui.js";

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
      PHOTON_CHANNEL_SETUP.setup({
        environment: photonSetupEnvironment("cli-missing", { kind: "unresolved" }),
        state: {
          agentName: "agent",
          project: { kind: "unresolved" },
          projectPath: "/project",
        },
        ui: createPhotonSetupUi({
          asker: asker({ "photon-phone-number": "+15551234567" }),
          prompter: fake.prompter,
        }),
        photonDeps: effects,
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

    await PHOTON_CHANNEL_SETUP.setup({
      environment: photonSetupEnvironment("cli-missing", { kind: "unresolved" }),
      state: {
        agentName: "weather-agent",
        project: { kind: "unresolved" },
        projectPath: "/project",
      },
      ui: createPhotonSetupUi({
        asker: asker({ "photon-phone-number": "+15551234567" }),
        prompter: fake.prompter,
      }),
      photonDeps: effects,
    });

    expect(effects.provisionProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: "eve · weather-agent" }),
    );
  });

  it("requires Vercel login when Connect is selected without an authenticated CLI", async () => {
    const fake = createFakePrompter({ single: () => "vercel" });

    await expect(
      PHOTON_CHANNEL_SETUP.setup({
        environment: photonSetupEnvironment("cli-missing", { kind: "unresolved" }),
        state: {
          agentName: "agent",
          project: { kind: "unresolved" },
          projectPath: "/project",
        },
        ui: createPhotonSetupUi({ asker: asker({}), prompter: fake.prompter }),
        photonDeps: deps(),
      }),
    ).rejects.toThrow("vercel login");
  });
});
