import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, type ResolvedAiGateway, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless } from "../runner.js";
import {
  applyAiGatewayCredential,
  type ApplyAiGatewayCredentialDeps,
} from "./apply-ai-gateway-credential.js";

const silentSink: OutputSink = { write: () => {} };

function fakeDeps(
  overrides: Partial<ApplyAiGatewayCredentialDeps> = {},
): ApplyAiGatewayCredentialDeps {
  return {
    appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
    runVercelEnvPull: vi.fn(async () => true),
    detectAiGatewayResolution: vi.fn(async () => ({ kind: "unresolved" as const })),
    ...overrides,
  };
}

function createPrompter(): Prompter {
  return createFakePrompter().prompter;
}

function stateWith(overrides: Partial<SetupState>): SetupState {
  const state = createDefaultSetupState();
  state.projectPath = { kind: "resolved", inPlace: false, path: "/tmp/a" };
  return Object.assign(state, overrides);
}

/** Runs `perform` directly so the linked/unlinked branches stay testable past shouldRun. */
function performWith(
  prompter: Prompter,
  deps: ApplyAiGatewayCredentialDeps,
  plan: ResolvedAiGateway,
  linked: boolean,
) {
  const box = applyAiGatewayCredential({ prompter, deps });
  const state = stateWith({
    aiGateway: plan,
    project: linked ? { kind: "linked", projectId: "prj_x" } : { kind: "unresolved" },
  });
  return box.perform({ state, input: null, sink: silentSink });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyAiGatewayCredential perform", () => {
  it("writes a pasted key and never pulls env (byok)", async () => {
    const prompter = createPrompter();
    const deps = fakeDeps();
    await expect(
      performWith(prompter, deps, { kind: "byok", apiGatewayKey: "sk-test" }, true),
    ).resolves.toEqual({ kind: "api-key", envFile: ".env.local" });
    expect(deps.appendEnv).toHaveBeenCalledWith(
      expect.stringContaining(".env.local"),
      { AI_GATEWAY_API_KEY: "sk-test" },
      { force: true },
    );
    expect(deps.runVercelEnvPull).not.toHaveBeenCalled();
  });

  it("pulls env for a linked project and returns the detected AI Gateway (inherit)", async () => {
    const prompter = createPrompter();
    const deps = fakeDeps({
      detectAiGatewayResolution: vi.fn(async () => ({
        kind: "api-key" as const,
        envFile: ".env.local" as const,
      })),
    });

    await expect(performWith(prompter, deps, { kind: "inherit" }, true)).resolves.toEqual({
      kind: "api-key",
      envFile: ".env.local",
    });
    expect(deps.runVercelEnvPull).toHaveBeenCalled();
  });

  it("warns and stays unresolved when inheriting without a linked project", async () => {
    const prompter = createPrompter();
    const deps = fakeDeps();
    await expect(performWith(prompter, deps, { kind: "inherit" }, false)).resolves.toEqual({
      kind: "unresolved",
    });
    expect(deps.runVercelEnvPull).not.toHaveBeenCalled();
    expect(prompter.log.warning).toHaveBeenCalled();
  });

  it("leaves provider-owned credentials alone for byop", async () => {
    const prompter = createPrompter();
    const deps = fakeDeps();
    await expect(performWith(prompter, deps, { kind: "byop" }, false)).resolves.toEqual({
      kind: "unresolved",
    });
    expect(deps.appendEnv).not.toHaveBeenCalled();
    expect(deps.runVercelEnvPull).not.toHaveBeenCalled();
    expect(prompter.log.warning).not.toHaveBeenCalled();
  });

  it("does not claim success when the env pull fails (inherit)", async () => {
    const prompter = createPrompter();
    const deps = fakeDeps({
      runVercelEnvPull: vi.fn(async () => false),
      detectAiGatewayResolution: vi.fn(async () => ({
        kind: "api-key" as const,
        envFile: ".env.local" as const,
      })),
    });

    await expect(performWith(prompter, deps, { kind: "inherit" }, true)).resolves.toEqual({
      kind: "api-key",
      envFile: ".env.local",
    });
    expect(prompter.log.success).not.toHaveBeenCalled();
    expect(prompter.log.warning).toHaveBeenCalled();
  });
});

describe("applyAiGatewayCredential box", () => {
  it("skips when a key is already resolved and the plan only inherits", () => {
    const box = applyAiGatewayCredential({ prompter: createPrompter(), deps: fakeDeps() });
    const state = stateWith({
      aiGatewayCredentials: { kind: "api-key", envFile: ".env.local" },
      aiGateway: { kind: "inherit" },
    });
    expect(box.shouldRun?.(state)).toBe(false);
  });

  it("runs and writes the key for a byok plan even when a key already exists", async () => {
    const deps = fakeDeps();
    const box = applyAiGatewayCredential({ prompter: createPrompter(), deps });
    const state = stateWith({
      aiGatewayCredentials: { kind: "api-key", envFile: ".env.local" },
      aiGateway: { kind: "byok", apiGatewayKey: "sk-new" },
    });
    expect(box.shouldRun?.(state)).toBe(true);

    const next = await runHeadless([box], state, silentSink);
    expect(next.aiGatewayCredentials).toEqual({ kind: "api-key", envFile: ".env.local" });
    expect(deps.appendEnv).toHaveBeenCalledWith(
      expect.stringContaining(".env.local"),
      { AI_GATEWAY_API_KEY: "sk-new" },
      { force: true },
    );
  });

  it("inherits for a freshly-linked project even with a key already detected", () => {
    const box = applyAiGatewayCredential({ prompter: createPrompter(), deps: fakeDeps() });
    const state = stateWith({
      aiGatewayCredentials: { kind: "api-key", envFile: ".env.local" },
      aiGateway: { kind: "inherit" },
      project: { kind: "linked", projectId: "prj_x" },
    });
    expect(box.shouldRun?.(state)).toBe(true);
  });

  it("skips inherit when no project is linked", () => {
    const box = applyAiGatewayCredential({ prompter: createPrompter(), deps: fakeDeps() });
    const state = stateWith({
      aiGatewayCredentials: { kind: "unresolved" },
      aiGateway: { kind: "inherit" },
      project: { kind: "unresolved" },
    });
    expect(box.shouldRun?.(state)).toBe(false);
  });

  it("skips byop because provider credentials are scaffold-owned", () => {
    const box = applyAiGatewayCredential({ prompter: createPrompter(), deps: fakeDeps() });
    const state = stateWith({
      aiGatewayCredentials: { kind: "unresolved" },
      aiGateway: { kind: "byop" },
      project: { kind: "unresolved" },
    });
    expect(box.shouldRun?.(state)).toBe(false);
  });
});
