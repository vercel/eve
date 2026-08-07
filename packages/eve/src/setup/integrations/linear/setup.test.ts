import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers, withPolicy } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import {
  applyLinearSetup,
  linearSafeConnectorSlug,
  prepareLinearSetup,
  type LinearSetupDeps,
} from "./setup.js";

function deps(): LinearSetupDeps {
  return {
    attachConnector: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    readProjectLink: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
    findConnector: vi.fn(async () => undefined),
    provisionConnector: vi.fn(async () => ({ id: "connector", uid: "linear/agent" })),
    writeTextFile: vi.fn(async () => {}),
  };
}
function contexts(answers: Record<string, unknown> = {}) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(withPolicy("assume")(headlessAsker())),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
  });
}

describe("Linear setup", () => {
  it("normalizes connector names", () => {
    expect(linearSafeConnectorSlug("eve-linear-agent")).toBe("eve-agent");
    expect(linearSafeConnectorSlug("linear")).toBe("agent");
  });
  it("prepares before provisioning", async () => {
    const effects = deps();
    const ctx = contexts();
    const plan = await prepareLinearSetup(ctx.prepare, effects);
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    await applyLinearSetup(plan, ctx.apply, effects);
    expect(effects.provisionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "agent" }),
    );
  });
  it("prepares reuse without attaching", async () => {
    const effects = deps();
    vi.mocked(effects.findConnector).mockResolvedValue({ id: "existing", uid: "linear/agent" });
    const ctx = contexts({ "linear.existing-connector": "reuse" });
    const plan = await prepareLinearSetup(ctx.prepare, effects);
    expect(effects.attachConnector).not.toHaveBeenCalled();
    await applyLinearSetup(plan, ctx.apply, effects);
    expect(effects.attachConnector).toHaveBeenCalledOnce();
  });
  it("requires a linked project", async () => {
    const effects = deps();
    vi.mocked(effects.readProjectLink).mockResolvedValue(undefined);
    await expect(prepareLinearSetup(contexts().prepare, effects)).rejects.toThrow("eve link");
    expect(effects.findConnector).not.toHaveBeenCalled();
  });
});
