import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { PrompterValue, SingleSelectOptions } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import type { VercelAuthStatus } from "#setup/vercel-project.js";

import {
  CONNECTION_QUESTION,
  EXTERNAL_PROVIDER_INSTRUCTIONS,
  EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
  PROVIDER_QUESTION,
  runVercelFlow,
  type VercelFlowDeps,
} from "./vercel.js";

const APP_ROOT = "/app/my-agent";

/** Answers the two entry questions; anything else is a test failure. */
function answers(provider: PrompterValue, connection?: PrompterValue) {
  return (opts: SingleSelectOptions<PrompterValue>): PrompterValue => {
    if (opts.message === PROVIDER_QUESTION) return provider;
    if (opts.message === CONNECTION_QUESTION && connection !== undefined) return connection;
    throw new Error(`Unexpected select: ${opts.message}`);
  };
}

function createDeps() {
  return {
    getVercelAuthStatus: vi.fn(async (): Promise<VercelAuthStatus> => "authenticated"),
    runLinkFlow: vi.fn<VercelFlowDeps["runLinkFlow"]>(async () => ({
      kind: "done",
      credential: "VERCEL_OIDC_TOKEN",
    })),
    appendEnv: vi.fn<VercelFlowDeps["appendEnv"]>(async () => ({
      written: ["AI_GATEWAY_API_KEY"],
      skipped: [],
    })),
    validateGatewayApiKey: vi.fn<VercelFlowDeps["validateGatewayApiKey"]>(async () => ({
      kind: "valid",
    })),
  };
}

describe("runVercelFlow", () => {
  it("delegates to the link flow for AI Gateway via a project", async () => {
    const fake = createFakePrompter({ single: answers("gateway", "project") });
    const deps = createDeps();

    const result = await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", credential: "VERCEL_OIDC_TOKEN" });
    // A project-less agent must be able to create its first project here, so
    // the branch drives the link flow in create-or-link mode (not the
    // existing-only mode `eve link` uses).
    expect(deps.runLinkFlow).toHaveBeenCalledExactlyOnceWith({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      projectSelection: "create-or-link",
    });
    expect(deps.appendEnv).not.toHaveBeenCalled();
    expect(fake.prompter.acknowledge).not.toHaveBeenCalled();
  });

  it("disables project linking when the Vercel CLI is missing", async () => {
    let connectionPrompt: SingleSelectOptions<PrompterValue> | undefined;
    const fake = createFakePrompter({
      single: (opts) => {
        if (opts.message === PROVIDER_QUESTION) return "gateway";
        if (opts.message === CONNECTION_QUESTION) {
          connectionPrompt = opts;
          return "own-key";
        }
        throw new Error(`Unexpected select: ${opts.message}`);
      },
      password: () => "sk-gateway-test",
    });
    const deps = createDeps();
    deps.getVercelAuthStatus.mockResolvedValueOnce("cli-missing");

    await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(connectionPrompt?.options[0]).toEqual({
      value: "project",
      label: "Connect via a project",
      hint: "vercel link + env pull",
      disabled: true,
      disabledReason: "Vercel CLI not found, see /vc",
      disabledReasonTone: "warning",
    });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
  });

  it("writes a pasted AI Gateway key to .env.local, trimmed", async () => {
    const fake = createFakePrompter({
      single: answers("gateway", "own-key"),
      password: () => "  sk-gateway-test  ",
    });
    const deps = createDeps();

    const result = await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", credential: "AI_GATEWAY_API_KEY" });
    // The trimmed key is validated against the gateway before it is saved.
    expect(deps.validateGatewayApiKey).toHaveBeenCalledExactlyOnceWith(
      "sk-gateway-test",
      undefined,
    );
    expect(deps.appendEnv).toHaveBeenCalledExactlyOnceWith(
      `${APP_ROOT}/.env.local`,
      { AI_GATEWAY_API_KEY: "sk-gateway-test" },
      { force: true },
    );
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
    expect(fake.prompter.log.success).toHaveBeenCalledWith(
      "Saved AI_GATEWAY_API_KEY to .env.local.",
    );
  });

  it("re-prompts when the gateway rejects the key, then saves the corrected one", async () => {
    const keys = ["bad-key", "good-key"];
    const fake = createFakePrompter({
      single: answers("gateway", "own-key"),
      password: () => keys.shift() ?? "good-key",
    });
    const deps = createDeps();
    deps.validateGatewayApiKey
      .mockResolvedValueOnce({ kind: "invalid", message: "The AI Gateway rejected this key." })
      .mockResolvedValueOnce({ kind: "valid" });

    const result = await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", credential: "AI_GATEWAY_API_KEY" });
    expect(deps.validateGatewayApiKey).toHaveBeenCalledTimes(2);
    expect(fake.prompter.log.error).toHaveBeenCalledOnce();
    // Only the corrected key is written, exactly once.
    expect(deps.appendEnv).toHaveBeenCalledExactlyOnceWith(
      `${APP_ROOT}/.env.local`,
      { AI_GATEWAY_API_KEY: "good-key" },
      { force: true },
    );
  });

  it("saves the key with a warning when validation is inconclusive", async () => {
    const fake = createFakePrompter({
      single: answers("gateway", "own-key"),
      password: () => "sk-offline",
    });
    const deps = createDeps();
    deps.validateGatewayApiKey.mockResolvedValueOnce({
      kind: "inconclusive",
      message: "network down",
    });

    const result = await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", credential: "AI_GATEWAY_API_KEY" });
    expect(fake.prompter.log.warning).toHaveBeenCalledOnce();
    expect(deps.appendEnv).toHaveBeenCalledOnce();
  });

  it("shows provider instructions and ends with the external-provider outcome", async () => {
    const fake = createFakePrompter({ single: answers("other") });
    const deps = createDeps();

    const result = await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", outcome: "external-provider" });
    expect(fake.prompter.acknowledge).toHaveBeenCalledExactlyOnceWith({
      message: EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
      lines: EXTERNAL_PROVIDER_INSTRUCTIONS,
    });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
    expect(deps.appendEnv).not.toHaveBeenCalled();
  });

  it("falls back to note when the prompter lacks acknowledge", async () => {
    const fake = createFakePrompter({ single: answers("other") });
    delete fake.prompter.acknowledge;
    const deps = createDeps();

    const result = await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", outcome: "external-provider" });
    expect(fake.prompter.note).toHaveBeenCalledWith(
      EXTERNAL_PROVIDER_INSTRUCTIONS.join("\n"),
      EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
    );
  });

  it("folds Esc on the entry questions into cancelled", async () => {
    const fake = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    });
    const deps = createDeps();

    const result = await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "cancelled" });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
  });

  it("folds Esc on the key paste into cancelled without writing", async () => {
    const fake = createFakePrompter({
      single: answers("gateway", "own-key"),
      password: () => {
        throw new WizardCancelledError();
      },
    });
    const deps = createDeps();

    const result = await runVercelFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "cancelled" });
    expect(deps.appendEnv).not.toHaveBeenCalled();
  });
});
