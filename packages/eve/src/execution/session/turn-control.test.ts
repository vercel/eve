import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTurnControl,
  nextTurnControl,
  splitTurnSignal,
  turnSteeredReason,
} from "#execution/session/turn-control.js";

afterEach(() => vi.unstubAllGlobals());

describe("createTurnControl", () => {
  it("constructs the turn's one controller eagerly", () => {
    const NativeAbortController = AbortController;
    const construct = vi.fn(() => new NativeAbortController());
    vi.stubGlobal(
      "AbortController",
      class {
        constructor() {
          return construct();
        }
      },
    );

    createTurnControl();

    expect(construct).toHaveBeenCalledTimes(1);
  });
});

describe("nextTurnControl", () => {
  it("keeps a control the turn left unaborted", () => {
    const used = createTurnControl();
    expect(nextTurnControl(used)).toBe(used);
  });

  it("replaces a control the turn aborted", () => {
    const used = createTurnControl();
    used.controller.abort(new Error("cancelled"));
    const next = nextTurnControl(used);
    expect(next.controller).not.toBe(used.controller);
    expect(next.controller.signal.aborted).toBe(false);
  });
});

describe("splitTurnSignal", () => {
  it("reads a steer as steering only", () => {
    const controller = new AbortController();
    const { abortSignal, steeringSignal } = splitTurnSignal(controller.signal);
    controller.abort(turnSteeredReason(new AbortController().signal));
    expect(steeringSignal.aborted).toBe(true);
    expect(abortSignal.aborted).toBe(false);
  });

  it("reads anything else as a cancel, with its reason", () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const { abortSignal, steeringSignal } = splitTurnSignal(controller.signal);
    controller.abort(reason);
    expect(abortSignal.aborted).toBe(true);
    expect(abortSignal.reason).toBe(reason);
    expect(steeringSignal.aborted).toBe(false);
  });

  it("hears a cancel that follows a steer, through the steer's replacement", () => {
    const first = new AbortController();
    const next = new AbortController();
    const { abortSignal } = splitTurnSignal(first.signal);
    first.abort(turnSteeredReason(next.signal));
    expect(abortSignal.aborted).toBe(false);
    const reason = new Error("cancelled");
    next.abort(reason);
    expect(abortSignal.reason).toBe(reason);
  });

  it("reads a chain that was aborted before the step began", () => {
    const first = new AbortController();
    const next = new AbortController();
    next.abort(new Error("cancelled"));
    first.abort(turnSteeredReason(next.signal));
    const { abortSignal, steeringSignal } = splitTurnSignal(first.signal);
    expect(steeringSignal.aborted).toBe(true);
    expect(abortSignal.aborted).toBe(true);
  });
});
