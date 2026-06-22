import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type {
  EditableSelectOptions,
  EditableSelectResult,
  PrompterValue,
  SelectEditable,
  SelectOption,
} from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import type { VercelAuthStatus } from "#setup/vercel-project.js";

import {
  EXTERNAL_PROVIDER_INSTRUCTIONS,
  EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
  PROVIDER_QUESTION,
  runProviderFlow,
  type ProviderFlowDeps,
} from "./provider.js";

const APP_ROOT = "/app/my-agent";
type ProviderConnection = "project" | "own-key" | "external";

/** Answers the provider question; anything else is a test failure. */
function answerProvider(provider: ProviderConnection): SelectEditable {
  return async (opts) => {
    if (opts.message === PROVIDER_QUESTION) return selectOption(opts, provider);
    throw new Error(`Unexpected select: ${opts.message}`);
  };
}

function selectOption<T extends PrompterValue, Payload>(
  opts: EditableSelectOptions<T, Payload>,
  value: PrompterValue,
): EditableSelectResult<T, Payload> {
  const option = opts.options.find((candidate) => candidate.value === value);
  if (option === undefined) throw new Error(`Provider option not found: ${String(value)}`);
  return { kind: "selected", value: option.value };
}

async function submitKey<T extends PrompterValue, Payload>(
  opts: EditableSelectOptions<T, Payload>,
  text: string,
): Promise<EditableSelectResult<T, Payload>> {
  const outcome = await opts.editable.validate(text, new AbortController().signal);
  if (outcome.kind === "rejected") throw new Error(outcome.message);
  return {
    kind: "submitted",
    value: opts.editable.value,
    text,
    payload: outcome.payload,
  };
}

function createDeps() {
  return {
    getVercelAuthStatus: vi.fn(async (): Promise<VercelAuthStatus> => "authenticated"),
    runLinkFlow: vi.fn<ProviderFlowDeps["runLinkFlow"]>(async () => ({
      kind: "done",
      credential: "VERCEL_OIDC_TOKEN",
    })),
    appendEnv: vi.fn<ProviderFlowDeps["appendEnv"]>(async () => ({
      written: ["AI_GATEWAY_API_KEY"],
      skipped: [],
    })),
    validateGatewayApiKey: vi.fn<ProviderFlowDeps["validateGatewayApiKey"]>(async () => ({
      kind: "valid",
    })),
  };
}

describe("runProviderFlow", () => {
  it("presents project, inline key, and external provider choices in one question", async () => {
    const fake = createFakePrompter({
      editable: async (opts) => {
        expect(opts.message).toBe(PROVIDER_QUESTION);
        expect(opts.options.map((option) => option.value)).toEqual([
          "project",
          "own-key",
          "external",
        ]);
        expect(opts.initialValue).toBe("project");
        return selectOption(opts, "project");
      },
    });
    const spinner = vi.fn(() => ({ stop: vi.fn() }));
    fake.prompter.log.spinner = spinner;
    const deps = createDeps();

    const result = await runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

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
    expect(spinner).toHaveBeenCalledExactlyOnceWith("Checking your Vercel login…");
  });

  it("disables project linking after the selected project path finds no Vercel CLI", async () => {
    let providerOptions: readonly SelectOption<PrompterValue>[] = [];
    let providerPromptCount = 0;
    const fake = createFakePrompter({
      editable: async (opts) => {
        if (opts.message !== PROVIDER_QUESTION) {
          throw new Error(`Unexpected select: ${opts.message}`);
        }
        providerOptions = opts.options;
        providerPromptCount += 1;
        return providerPromptCount === 1
          ? selectOption(opts, "project")
          : await submitKey(opts, "sk-gateway-test");
      },
    });
    const deps = createDeps();
    deps.getVercelAuthStatus.mockResolvedValueOnce("cli-missing");

    await runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(providerOptions[0]).toMatchObject({
      value: "project",
      disabled: true,
      disabledReason: "Vercel CLI not found, see /vc",
    });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
  });

  it("writes the inline AI Gateway key to .env.local, trimmed", async () => {
    const inlineKey = "  sk-inline  ";
    const fake = createFakePrompter({
      editable: async (opts) => {
        expect(opts.editable.value).toBe("own-key");
        expect(opts.editable.mask).toBe(true);

        const outcome = await opts.editable.validate(inlineKey, new AbortController().signal);
        if (outcome.kind !== "accepted") throw new Error("Expected the inline key to be accepted.");
        return {
          kind: "submitted",
          value: opts.editable.value,
          text: inlineKey,
          payload: outcome.payload,
        };
      },
    });
    const spinner = vi.fn(() => ({ stop: vi.fn() }));
    fake.prompter.log.spinner = spinner;
    const deps = createDeps();

    const result = await runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", credential: "AI_GATEWAY_API_KEY" });
    expect(deps.validateGatewayApiKey).toHaveBeenCalledOnce();
    expect(deps.validateGatewayApiKey.mock.calls[0]?.[0]).toBe("sk-inline");
    expect(deps.appendEnv).toHaveBeenCalledExactlyOnceWith(
      `${APP_ROOT}/.env.local`,
      { AI_GATEWAY_API_KEY: "sk-inline" },
      { force: true },
    );
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
    expect(fake.prompter.log.success).toHaveBeenCalledWith(
      "Saved AI_GATEWAY_API_KEY to .env.local.",
    );
    expect(spinner).not.toHaveBeenCalled();
    expect(deps.getVercelAuthStatus).toHaveBeenCalledOnce();
  });

  it("returns the committed key when interrupted during the env write", async () => {
    const fake = createFakePrompter({
      editable: (opts) => submitKey(opts, "sk-committed"),
    });
    const deps = createDeps();
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    deps.appendEnv.mockImplementationOnce(async () => {
      writeStarted.resolve();
      await releaseWrite.promise;
      return { written: ["AI_GATEWAY_API_KEY"], skipped: [] };
    });
    const controller = new AbortController();

    const execution = runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      signal: controller.signal,
      deps,
    });
    await writeStarted.promise;
    controller.abort();
    releaseWrite.resolve();

    await expect(execution).resolves.toEqual({
      kind: "done",
      credential: "AI_GATEWAY_API_KEY",
    });
  });

  it("keeps rejected key retries inside one provider prompt", async () => {
    const keys = ["bad-key", "still-bad-key", "good-key"];
    const validationMessages: (string | undefined)[] = [];
    const fake = createFakePrompter({
      editable: async (opts) => {
        for (const key of keys) {
          const outcome = await opts.editable.validate(key, new AbortController().signal);
          validationMessages.push(outcome.kind === "rejected" ? outcome.message : undefined);
          if (outcome.kind === "accepted") {
            return {
              kind: "submitted",
              value: opts.editable.value,
              text: key,
              payload: outcome.payload,
            };
          }
        }
        throw new Error("Expected an accepted inline key.");
      },
    });
    const deps = createDeps();
    deps.validateGatewayApiKey
      .mockResolvedValueOnce({ kind: "invalid", message: "The AI Gateway rejected this key." })
      .mockResolvedValueOnce({ kind: "invalid", message: "The replacement rejection." })
      .mockResolvedValueOnce({ kind: "valid" });

    const result = await runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", credential: "AI_GATEWAY_API_KEY" });
    expect(deps.validateGatewayApiKey).toHaveBeenCalledTimes(3);
    expect(fake.prompter.log.error).not.toHaveBeenCalled();
    expect(fake.selectMessages).toEqual([PROVIDER_QUESTION]);
    expect(validationMessages).toEqual([
      "The AI Gateway rejected this key. Check the key and try again, or Esc to cancel.",
      "The replacement rejection. Check the key and try again, or Esc to cancel.",
      undefined,
    ]);
    // Only the corrected key is written, exactly once.
    expect(deps.appendEnv).toHaveBeenCalledExactlyOnceWith(
      `${APP_ROOT}/.env.local`,
      { AI_GATEWAY_API_KEY: "good-key" },
      { force: true },
    );
  });

  it("saves the key with a warning when validation is inconclusive", async () => {
    const fake = createFakePrompter({
      editable: (opts) => submitKey(opts, "sk-offline"),
    });
    const deps = createDeps();
    deps.validateGatewayApiKey.mockResolvedValueOnce({
      kind: "inconclusive",
      message: "network down",
    });

    const result = await runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "done", credential: "AI_GATEWAY_API_KEY" });
    expect(fake.prompter.log.warning).toHaveBeenCalledOnce();
    expect(deps.appendEnv).toHaveBeenCalledOnce();
  });

  it("starts Vercel auth eagerly without making another provider wait for it", async () => {
    const order: string[] = [];
    const auth = Promise.withResolvers<VercelAuthStatus>();
    const fake = createFakePrompter({
      editable: async (opts) => {
        order.push("provider");
        return answerProvider("external")(opts);
      },
    });
    const deps = createDeps();
    deps.getVercelAuthStatus.mockImplementationOnce(() => {
      order.push("auth");
      return auth.promise;
    });

    const execution = runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });
    expect(order).toEqual(["auth", "provider"]);
    const result = await execution;

    expect(result).toEqual({ kind: "external-provider" });
    expect(fake.prompter.acknowledge).toHaveBeenCalledExactlyOnceWith({
      message: EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
      lines: EXTERNAL_PROVIDER_INSTRUCTIONS,
    });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
    expect(deps.appendEnv).not.toHaveBeenCalled();
    expect(deps.getVercelAuthStatus).toHaveBeenCalledOnce();
  });

  it("falls back to note when the prompter lacks acknowledge", async () => {
    const fake = createFakePrompter({ editable: answerProvider("external") });
    delete fake.prompter.acknowledge;
    const deps = createDeps();

    const result = await runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "external-provider" });
    expect(fake.prompter.note).toHaveBeenCalledWith(
      EXTERNAL_PROVIDER_INSTRUCTIONS.join("\n"),
      EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
    );
  });

  it("folds Esc on the entry questions into cancelled", async () => {
    const fake = createFakePrompter({
      editable: () => {
        throw new WizardCancelledError();
      },
    });
    const deps = createDeps();

    const result = await runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps });

    expect(result).toEqual({ kind: "cancelled" });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
  });

  it("rejects a prompter without inline editing instead of opening a second prompt", async () => {
    const fake = createFakePrompter({ single: () => "own-key" });
    const deps = createDeps();

    await expect(
      runProviderFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps }),
    ).rejects.toThrow("The provider flow requires an editable-select prompter.");
    expect(deps.getVercelAuthStatus).not.toHaveBeenCalled();
    expect(deps.appendEnv).not.toHaveBeenCalled();
  });
});
