import { describe, expect, it } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { composeOnboardingBoxes } from "./onboarding.js";
import { createDefaultSetupState, type SetupState } from "./state.js";

function composeBoxes() {
  return composeOnboardingBoxes({
    prompter: createFakePrompter().prompter,
  });
}

function resolvedState(setupMode: SetupState["setupMode"]): SetupState {
  return {
    ...createDefaultSetupState(),
    setupMode,
    projectPath: { kind: "resolved", inPlace: false, path: "/tmp/my-agent" },
  };
}

/** Boxes a one-shot run must skip: every interview and post-scaffold step. */
const GATED_IDS = [
  "resolve-provisioning",
  "select-model",
  "select-channels",
  "select-connections",
  "detect-ai-gateway",
  "link-project",
  "apply-ai-gateway-credential",
  "add-channels",
  "add-connections",
  "deploy-project",
  "select-chat",
];

describe("composeOnboardingBoxes", () => {
  it("orders the interview: name, mode, model, channels, connections, then deployment", () => {
    const ids = composeBoxes().map((box) => box.id);

    expect(ids[0]).toBe("resolve-target");
    expect(ids[1]).toBe("select-setup-mode");
    expect(ids[ids.length - 1]).toBe("one-shot-next-steps");
    expect(ids).toContain("scaffold");
    // The agent is described first; where it runs is the last interview
    // decision, because the channel and connection selections inform it. All
    // of it stays ahead of any filesystem write.
    expect(ids[2]).toBe("select-model");
    expect(ids.indexOf("select-channels")).toBe(ids.indexOf("select-model") + 1);
    expect(ids.indexOf("select-connections")).toBe(ids.indexOf("select-channels") + 1);
    expect(ids.indexOf("resolve-provisioning")).toBe(ids.indexOf("select-connections") + 1);
    expect(ids.indexOf("resolve-provisioning")).toBeLessThan(ids.indexOf("scaffold"));
    expect(ids.indexOf("add-connections")).toBeGreaterThan(ids.indexOf("scaffold"));
  });

  it("one-shot gates every interview and post-scaffold box but keeps the scaffold path", () => {
    const boxes = composeBoxes();
    const state = resolvedState("one-shot");

    for (const id of GATED_IDS) {
      const box = boxes.find((candidate) => candidate.id === id);
      expect(box, id).toBeDefined();
      expect(box?.shouldRun?.(state), id).toBe(false);
    }
    for (const id of ["preflight", "scaffold", "one-shot-next-steps"]) {
      const box = boxes.find((candidate) => candidate.id === id);
      expect(box, id).toBeDefined();
      expect(box?.shouldRun?.(state) ?? true, id).toBe(true);
    }
  });

  it("deploys during onboarding only when Slack was scaffolded", () => {
    const boxes = composeBoxes();
    const deploy = boxes.find((box) => box.id === "deploy-project");
    const base = {
      ...resolvedState("complete"),
      deploymentPending: true,
      vercelProject: { kind: "new", project: "my-agent", team: "acme" } as const,
    };

    // Web-only onboarding: deployment work is pending but Slack is absent.
    expect(deploy?.shouldRun?.({ ...base, webScaffolded: true })).toBe(false);
    expect(deploy?.shouldRun?.({ ...base, slackScaffolded: true })).toBe(true);
  });

  it("complete setup defers to each box's own shouldRun", () => {
    const boxes = composeBoxes();
    const state = resolvedState("complete");

    // The link box self-skips without a planned project even in complete mode.
    const link = boxes.find((box) => box.id === "link-project");
    expect(link?.shouldRun?.(state)).toBe(false);

    // The channel interview runs in complete mode and is skipped one-shot.
    const channels = boxes.find((box) => box.id === "select-channels");
    expect(channels?.shouldRun?.(state) ?? true).toBe(true);

    // The one-shot epilogue never fires on a complete run.
    const epilogue = boxes.find((box) => box.id === "one-shot-next-steps");
    expect(epilogue?.shouldRun?.(state)).toBe(false);
  });
});
