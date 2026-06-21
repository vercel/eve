import type { PromptColors } from "#setup/cli/index.js";
import { describe, expect, it } from "vitest";

import { initialQuitGuardState, quitHintNote, reduceQuitGuard } from "./quit-guard.js";

const identity = (text: string) => text;

const colors: PromptColors = {
  blue: identity,
  bold: identity,
  cyan: identity,
  dim: identity,
  gray: identity,
  green: identity,
  inverse: identity,
  red: identity,
  strikethrough: identity,
  white: identity,
  yellow: identity,
};

describe("reduceQuitGuard", () => {
  it("arms on the first Escape without quitting", () => {
    const result = reduceQuitGuard(initialQuitGuardState, { type: "escape" });
    expect(result.action).toBe("arm");
    expect(result.state.armed).toBe(true);
  });

  it("quits on the second consecutive Escape", () => {
    const armed = reduceQuitGuard(initialQuitGuardState, { type: "escape" }).state;
    const result = reduceQuitGuard(armed, { type: "escape" });
    expect(result.action).toBe("quit");
  });

  it("disarms when any other key follows the first Escape", () => {
    const armed = reduceQuitGuard(initialQuitGuardState, { type: "escape" }).state;
    const result = reduceQuitGuard(armed, { type: "other-key" });
    expect(result.action).toBe("disarm");
    expect(result.state.armed).toBe(false);
  });

  it("does nothing for other keys while disarmed", () => {
    const result = reduceQuitGuard(initialQuitGuardState, { type: "other-key" });
    expect(result.action).toBe("none");
    expect(result.state).toBe(initialQuitGuardState);
  });

  it("re-arms after disarming so a fresh double press still quits", () => {
    const armed = reduceQuitGuard(initialQuitGuardState, { type: "escape" }).state;
    const disarmed = reduceQuitGuard(armed, { type: "other-key" }).state;
    const reArmed = reduceQuitGuard(disarmed, { type: "escape" });
    expect(reArmed.action).toBe("arm");
    expect(reduceQuitGuard(reArmed.state, { type: "escape" }).action).toBe("quit");
  });
});

describe("quitHintNote", () => {
  it("returns nothing while disarmed", () => {
    expect(quitHintNote(initialQuitGuardState, colors)).toBeUndefined();
  });

  it("mentions pressing Escape again to quit while armed", () => {
    const note = quitHintNote({ armed: true }, colors);
    expect(note).toContain("Esc");
    expect(note).toContain("quit");
  });
});
