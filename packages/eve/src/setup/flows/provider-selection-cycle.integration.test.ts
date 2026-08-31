import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { DEFAULT_CHATGPT_MODEL_SELECTION } from "#shared/chatgpt-model.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import {
  readProviderSelection,
  writeProviderSelection,
  type ProviderSelection,
} from "#setup/provider-settings.js";

import { runModelFlow, type CurrentAgentModel, type ModelFlowDeps } from "./model.js";
import { runProviderFlow, type ProviderFlowDeps, type ProviderPickerChoice } from "./provider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider selection", () => {
  it("cycles among independently available providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-provider-selection-"));
    roots.push(root);
    await writeFile(join(root, ".env.local"), "AI_GATEWAY_API_KEY=key\nVERCEL_OIDC_TOKEN=token\n");
    await writeProviderSelection(root, "ai-gateway-project");

    let currentModel: CurrentAgentModel = {
      id: DEFAULT_AGENT_MODEL_ID,
      routing: { kind: "gateway", target: "openai" },
      reasoning: null,
      serviceTier: { kind: "standard" },
      editable: true,
      settingsEditable: true,
    };
    const choices: ProviderPickerChoice[] = [
      { kind: "chatgpt" },
      { kind: "ai-gateway-project" },
      { kind: "ai-gateway-key", key: "replacement-key", validation: { kind: "valid" } },
      { kind: "ai-gateway-project" },
    ];
    const providerDeps: ProviderFlowDeps = {
      getVercelAuthStatus: vi.fn<ProviderFlowDeps["getVercelAuthStatus"]>(
        async () => "authenticated",
      ),
      runLinkFlow: vi.fn<ProviderFlowDeps["runLinkFlow"]>(async () => ({ kind: "done" })),
      appendEnv: vi.fn<ProviderFlowDeps["appendEnv"]>(async () => ({
        written: ["AI_GATEWAY_API_KEY"],
        skipped: [],
      })),
      validateGatewayApiKey: vi.fn<ProviderFlowDeps["validateGatewayApiKey"]>(async () => ({
        kind: "valid",
      })),
    };
    const applySettings = vi.fn<ModelFlowDeps["applySettings"]>(async ({ patch }) => {
      if (patch.model.kind !== "set") return { kind: "unchanged" };
      const chatGpt = patch.model.value === DEFAULT_CHATGPT_MODEL_SELECTION;
      currentModel = {
        ...currentModel,
        id: patch.model.value,
        routing: chatGpt
          ? { kind: "external", provider: "codex" }
          : { kind: "gateway", target: patch.model.value.split("/")[0] ?? "" },
      };
      return { kind: "changed", changed: ["model"], model: patch.model.value };
    });
    const deps: Partial<ModelFlowDeps> = {
      readCurrentModel: vi.fn(async () => currentModel),
      applySettings,
      selectModel: { fetchModels: async () => [] },
      runProviderFlow: (input) =>
        runProviderFlow({
          ...input,
          picker: async () => {
            const choice = choices.shift();
            if (choice === undefined) throw new Error("Provider choice script exhausted");
            return choice;
          },
          deps: providerDeps,
        }),
      ensureChatGptAuth: vi.fn(async () => {}),
    };

    const selectNextProvider = async (expected: ProviderSelection): Promise<void> => {
      const { prompter } = createFakePrompter({ single: () => "provider" });
      await expect(runModelFlow({ appRoot: root, prompter, deps })).resolves.toMatchObject({
        kind: "done",
        providerSelection: expected,
      });
      await expect(readProviderSelection(root)).resolves.toBe(expected);
    };

    await selectNextProvider("chatgpt");
    await selectNextProvider("ai-gateway-project");
    await selectNextProvider("ai-gateway-key");
    await selectNextProvider("ai-gateway-project");

    expect(choices).toEqual([]);
    expect(providerDeps.runLinkFlow).not.toHaveBeenCalled();
    expect(providerDeps.getVercelAuthStatus).not.toHaveBeenCalled();
    expect(providerDeps.appendEnv).toHaveBeenCalledOnce();
    expect(deps.ensureChatGptAuth).toHaveBeenCalledOnce();
    expect(applySettings).toHaveBeenCalledTimes(2);
  });
});
