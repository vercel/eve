import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { createSelectOptionCodec } from "#setup/cli/select-option-codec.js";
import { filterOptions } from "#setup/cli/select-state.js";
import { WizardCancelledError } from "#setup/step.js";
import { runRegistryFlow, type RegistryFlowDeps } from "./registry.js";
function deps(): RegistryFlowDeps {
  return {
    browseRegistryCatalog: vi.fn(async () => ({
      items: [{ address: "connection/linear", name: "Linear", source: "Vercel" }],
      total: 1,
      errors: [],
    })),
    installRegistryItem: vi.fn(async () => ({ output: [] })),
    detectDeployment: vi.fn(async () => ({ state: "unlinked" }) as const),
    runDeployFlow: vi.fn(async () => ({ kind: "deployed" }) as const),
  };
}
describe("runRegistryFlow", () => {
  it("finds providers by capability or title and installs the filtered selection", async () => {
    const flow = deps();
    flow.browseRegistryCatalog = vi.fn(async () => ({
      items: [
        {
          address: "channel/blooio",
          name: "channel/blooio",
          title: "Blooio",
          description: "Send and receive iMessage, RCS, and SMS through Blooio.",
          source: "Vercel",
        },
        {
          address: "channel/linq",
          name: "channel/linq",
          title: "Linq",
          description: "Connect an eve agent to iMessage and SMS through Linq.",
          source: "Vercel",
        },
        {
          address: "channel/teams",
          name: "channel/teams",
          title: "Microsoft Teams",
          source: "Vercel",
        },
      ],
      total: 3,
      errors: [],
    }));
    const fake = createFakePrompter({
      single: (options) => {
        const codec = createSelectOptionCodec(options.options);
        const matches = filterOptions(codec.options, " iMESSAGE ");
        expect(matches.map((option) => codec.decode(option.value))).toEqual([
          "channel/blooio",
          "channel/linq",
        ]);
        expect(filterOptions(codec.options, "microsoft").map((option) => option.label)).toEqual([
          "channel/teams",
        ]);
        expect(filterOptions(codec.options, "unrelated")).toEqual([]);
        return codec.decode(matches[0]!.value);
      },
    });
    await runRegistryFlow({ appRoot: "/agent", prompter: fake.prompter, deps: flow });
    expect(flow.installRegistryItem).toHaveBeenCalledWith(
      "/agent",
      "channel/blooio",
      expect.any(Object),
    );
  });
  it("installs into a workspace agent while keeping project effects at the workspace root", async () => {
    const flow = deps();
    const fake = createFakePrompter();
    await runRegistryFlow({
      appRoot: "/workspace",
      installRoot: "/workspace/agents/support",
      initialAddress: "connection/linear",
      prompter: fake.prompter,
      deps: flow,
    });

    expect(flow.installRegistryItem).toHaveBeenCalledWith(
      "/workspace/agents/support",
      "connection/linear",
      expect.any(Object),
    );
    expect(flow.detectDeployment).not.toHaveBeenCalled();
  });

  it("searches one catalog and installs the chosen item without a review", async () => {
    const flow = deps();
    const fake = createFakePrompter({
      single: (options) => {
        expect(options.search).toBe(true);
        return "connection/linear";
      },
    });
    expect(
      (await runRegistryFlow({ appRoot: "/agent", prompter: fake.prompter, deps: flow })).kind,
    ).toBe("done");
    expect(fake.selectMessages).toEqual(["Add to your agent"]);
    expect(flow.installRegistryItem).toHaveBeenCalledOnce();
    expect(flow.installRegistryItem).toHaveBeenCalledWith(
      "/agent",
      "connection/linear",
      expect.any(Object),
    );
  });
  it("installs an explicit address without another confirmation", async () => {
    const flow = deps();
    const fake = createFakePrompter();
    await runRegistryFlow({
      appRoot: "/agent",
      initialAddress: "connection/linear",
      prompter: fake.prompter,
      deps: flow,
    });
    expect(fake.selectMessages).toEqual([]);
    expect(flow.browseRegistryCatalog).not.toHaveBeenCalled();
    expect(flow.installRegistryItem).toHaveBeenCalledOnce();
  });
  it("reports unfinished setup separately from a cancelled installation", async () => {
    const flow = deps();
    flow.installRegistryItem = vi.fn(async () => ({
      output: [],
      setupIncomplete: { resumeCommand: "eve add channel/slack --skip-install" },
    }));

    await expect(
      runRegistryFlow({
        appRoot: "/agent",
        initialAddress: "channel/slack",
        prompter: createFakePrompter().prompter,
        deps: flow,
      }),
    ).resolves.toEqual({
      kind: "done",
      result: {
        outcomes: [
          {
            kind: "incomplete",
            title: "channel/slack",
            resumeCommand: "eve add channel/slack --skip-install",
          },
        ],
      },
    });
  });
  it("passes the install failure output sink through to the registry installer", async () => {
    const flow = deps();
    const fake = createFakePrompter();
    const onInstallFailureOutput = vi.fn();

    await runRegistryFlow({
      appRoot: "/agent",
      initialAddress: "connection/linear",
      prompter: fake.prompter,
      onInstallFailureOutput,
      deps: flow,
    });

    expect(flow.installRegistryItem).toHaveBeenCalledWith(
      "/agent",
      "connection/linear",
      expect.objectContaining({ onInstallFailureOutput }),
    );
  });

  it("reports an installation failure without another decision prompt", async () => {
    const flow = deps();
    flow.installRegistryItem = vi.fn(async () => {
      throw new Error("Dependency installation failed.");
    });
    const fake = createFakePrompter();

    await expect(
      runRegistryFlow({
        appRoot: "/agent",
        initialAddress: "connection/linear",
        prompter: fake.prompter,
        deps: flow,
      }),
    ).resolves.toMatchObject({
      kind: "done",
      result: {
        outcomes: [
          {
            kind: "failed",
            title: "connection/linear",
            message: "Dependency installation failed.",
          },
        ],
      },
    });

    expect(fake.prompter.log.error).not.toHaveBeenCalled();
    expect(fake.selectMessages).toEqual([]);
  });

  it("cancels before installing anything", async () => {
    const flow = deps();
    const fake = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    });
    expect(
      await runRegistryFlow({ appRoot: "/agent", prompter: fake.prompter, deps: flow }),
    ).toEqual({ kind: "cancelled" });
    expect(flow.installRegistryItem).not.toHaveBeenCalled();
  });
});
