import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, InteractionRequired, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyPhotonSetup, preparePhotonSetup, type PhotonSetupDeps } from "./setup-flow.js";

const ANSWERS = {
  "photon-credentials": "portable",
  "photon-project-source": "create",
  "photon-project-name": "Agent Messages",
  "photon-phone-number": "+15551234567",
};
function deps(): PhotonSetupDeps {
  return {
    appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    findDedicatedLine: vi.fn(async () => undefined),
    readProjectLink: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
    openUrl: vi.fn(),
    provisionConnector: vi.fn(async () => ({ id: "connector", uid: "photon/agent" })),
    provisionProject: vi.fn(async () => ({
      projectId: "photon",
      projectSecret: "secret",
      cleanup: vi.fn(async () => {}),
    })),
    useProject: vi.fn(),
    writeTextFile: vi.fn(async () => {}),
  };
}
function contexts(
  answers: Record<string, unknown>,
  auth: "authenticated" | "cli-missing" = "authenticated",
) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment(auth, { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
  });
}

describe("Photon setup", () => {
  it("collects all decisions before mutation", async () => {
    const effects = deps();
    await expect(
      preparePhotonSetup(
        contexts({ "photon-credentials": "portable", "photon-project-source": "create" }).prepare,
        effects,
      ),
    ).rejects.toBeInstanceOf(InteractionRequired);
    expect(effects.provisionProject).not.toHaveBeenCalled();
    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });
  it("applies a portable plan", async () => {
    const effects = deps();
    const ctx = contexts(ANSWERS, "cli-missing");
    const plan = await preparePhotonSetup(ctx.prepare, effects);
    expect(effects.provisionProject).not.toHaveBeenCalled();
    await applyPhotonSetup(plan, ctx.apply, effects);
    expect(effects.provisionProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: "Agent Messages" }),
    );
    expect(effects.appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      IMESSAGE_PROJECT_ID: "photon",
      IMESSAGE_PROJECT_SECRET: "secret",
    });
  });
  it("uses an existing dedicated project without asking for an operator number", async () => {
    const effects = deps();
    vi.mocked(effects.findDedicatedLine).mockResolvedValue("+15550000000");
    vi.mocked(effects.useProject).mockResolvedValue({
      projectId: "project-id",
      projectSecret: "project-secret",
      assignedPhoneNumber: "+15550000000",
      cleanup: vi.fn(async () => {}),
    });
    const ctx = contexts({
      "photon-credentials": "portable",
      "photon-project-source": "existing",
      "photon-project-id": "project-id",
      "photon-project-secret": "project-secret",
    });

    const plan = await preparePhotonSetup(ctx.prepare, "agent", effects);
    await applyPhotonSetup(plan, ctx.apply, effects);

    expect(effects.useProject).toHaveBeenCalledWith({
      projectId: "project-id",
      projectSecret: "project-secret",
      dedicatedLine: "+15550000000",
      phoneNumber: undefined,
    });
  });

  it("requires a linked project for Connect", async () => {
    const effects = deps();
    vi.mocked(effects.readProjectLink).mockResolvedValue(undefined);
    await expect(
      preparePhotonSetup(contexts({ ...ANSWERS, "photon-credentials": "vercel" }).prepare, effects),
    ).rejects.toThrow("eve link");
    expect(effects.provisionProject).not.toHaveBeenCalled();
  });
});
