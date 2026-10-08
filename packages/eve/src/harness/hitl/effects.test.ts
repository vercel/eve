import { describe, expect, it, vi } from "vitest";
import type { Step } from "#harness/step/context.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { PendingAuthorizationResultKey } from "#harness/authorization.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import type { HarnessSession } from "#harness/types.js";
import type { EffectCommand } from "./command.js";
import { beforeStep } from "./reducer.js";
import {
  applyHumanInputDecision,
  dispatchHumanInputEffects,
  effectHandlers,
  forwardedDelivery,
  type HumanInputEffectHandlers,
} from "./effects.js";
import { ALICE, BOB } from "#internal/testing/hitl.js";

const forward: EffectCommand = {
  type: "forwardAnswer",
  route: { childContinuationToken: "child" },
  responses: [{ requestId: "a", optionId: "approve" }],
};
const withdraw: EffectCommand = { type: "withdrawQuestion", control: "control", requestId: "a" };
const resume: Extract<EffectCommand, { type: "resumeAuthorization" }> = {
  type: "resumeAuthorization",
  requester: ALICE,
  result: {
    attemptId: "attempt",
    name: "github",
    hookUrl: "https://example.test/hook",
    callback: { params: {}, method: "GET" },
  },
};
function handlers(): HumanInputEffectHandlers {
  return {
    forwardAnswer: vi.fn(async () => {}),
    withdrawQuestion: vi.fn(async () => {}),
    resumeAuthorization: vi.fn(async ({ result, requester }) => [
      { type: "authorization.resumed" as const, result, requester },
    ]),
  };
}
function boundary() {
  let session: HarnessSession = {
    sessionId: "s",
    continuationToken: "http:test",
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100000 },
    history: [],
  };
  const order: string[] = [];
  const step: Pick<Step, "view" | "apply" | "ctx"> = {
    ctx: new ContextContainer(),
    view: () => sessionView(initialSessionProjection(), session.state),
    apply: async (transition) => {
      session = await applyTransition(session, transition, async (event) => {
        order.push(event.type);
      });
      order.push("applied");
    },
  };
  return { step, order, session: () => session };
}

describe("HumanInput ordered effects", () => {
  it("awaits every effect in command order and returns their outcomes in that order", async () => {
    const order: string[] = [];
    const h = handlers();
    h.forwardAnswer = async () => {
      order.push("forward");
    };
    h.withdrawQuestion = async () => {
      expect(order).toEqual(["forward"]);
      order.push("withdraw");
    };
    h.resumeAuthorization = async ({ result, requester }) => {
      expect(order).toEqual(["forward", "withdraw"]);
      order.push("resume");
      return [{ type: "authorization.resumed", result, requester }];
    };
    const outcomes = await dispatchHumanInputEffects([forward, withdraw, resume], h);
    expect(order).toEqual(["forward", "withdraw", "resume"]);
    expect(outcomes).toEqual([
      { type: "authorization.resumed", result: resume.result, requester: ALICE },
    ]);
  });

  it("deduplicates by request/attempt identity, not by command object identity", async () => {
    const h = handlers();
    await dispatchHumanInputEffects(
      [forward, { ...forward }, withdraw, { ...withdraw }, resume, { ...resume }],
      h,
    );
    expect(h.forwardAnswer).toHaveBeenCalledTimes(1);
    expect(h.withdrawQuestion).toHaveBeenCalledTimes(1);
    expect(h.resumeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("does not conflate request ids belonging to different destinations", async () => {
    const h = handlers();
    await dispatchHumanInputEffects(
      [forward, { ...forward, route: { childContinuationToken: "other" } }],
      h,
    );
    expect(h.forwardAnswer).toHaveBeenCalledTimes(2);
  });

  it("forwards only new requests in a partially overlapping batch", async () => {
    const h = handlers();
    await dispatchHumanInputEffects(
      [
        forward,
        { ...forward, responses: [...forward.responses, { requestId: "b", optionId: "cancel" }] },
      ],
      h,
    );
    expect(h.forwardAnswer).toHaveBeenNthCalledWith(2, {
      ...forward,
      responses: [{ requestId: "b", optionId: "cancel" }],
    });
  });

  it("applies the machine transition before transport and installs callbacks only in scoped context", async () => {
    const b = boundary();
    const h = handlers();
    h.forwardAnswer = async () => {
      expect(b.step.view().turn.grants).toEqual(["proof"]);
      b.order.push("forward");
    };
    await applyHumanInputDecision(
      b.step,
      {
        transition: { turn: { ...b.step.view().turn, grants: ["proof"] }, signIns: [], events: [] },
        effects: [forward, resume],
      },
      h,
    );
    expect(b.order).toEqual(["applied", "forward", "applied"]);
    expect(b.step.ctx?.get(PendingAuthorizationResultKey)).toEqual([resume.result]);
    expect(b.step.ctx?.get(AuthKey)).toEqual(ALICE);
    const restored = sessionView(
      initialSessionProjection(),
      JSON.parse(JSON.stringify(b.session().state)),
    );
    expect(restored.turn).not.toHaveProperty("authorizationResults");
  });

  it("does not undo the applied transition or run later effects when a transport fails", async () => {
    const b = boundary();
    const h = handlers();
    h.forwardAnswer = async () => {
      throw new Error("transport failed");
    };
    await expect(
      applyHumanInputDecision(
        b.step,
        {
          transition: {
            turn: { ...b.step.view().turn, grants: ["proof"] },
            signIns: [],
            events: [],
          },
          effects: [forward, withdraw],
        },
        h,
      ),
    ).rejects.toThrow("transport failed");
    expect(b.step.view().turn.grants).toEqual(["proof"]);
    expect(h.withdrawQuestion).not.toHaveBeenCalled();
    expect(b.order).toEqual(["applied"]);
  });

  it("upserts callback arrivals in scoped context without persisting receipts", async () => {
    const b = boundary();
    const arrivals = [
      { type: "authorization.resumed" as const, result: resume.result, requester: ALICE },
      { type: "authorization.resumed" as const, result: resume.result, requester: BOB },
    ];
    await applyHumanInputDecision(b.step, beforeStep(b.step.view(), arrivals), handlers());
    expect(b.step.ctx?.get(PendingAuthorizationResultKey)).toEqual([resume.result]);
    expect(b.step.ctx?.get(AuthKey)).toEqual(BOB);
    expect(b.step.view().turn).not.toHaveProperty("authorizationResults");
  });

  it("re-sends effects on durable-step replay rather than retaining invocation receipts", async () => {
    const h = handlers();
    await dispatchHumanInputEffects([forward, withdraw, resume], h);
    await dispatchHumanInputEffects([forward, withdraw, resume], h);
    expect(h.forwardAnswer).toHaveBeenCalledTimes(2);
    expect(h.withdrawQuestion).toHaveBeenCalledTimes(2);
    expect(h.resumeAuthorization).toHaveBeenCalledTimes(2);
  });

  it("preserves delivery attribution and remaps metadata in source payload order", () => {
    const delivery = {
      kind: "deliver" as const,
      auth: ALICE,
      payloads: [
        { inputResponses: [{ requestId: "ignored", optionId: "approve" }] },
        { inputResponses: [{ requestId: "b", optionId: "cancel" }] },
        { inputResponses: [{ requestId: "a", optionId: "approve" }] },
      ],
      deliveryMetadata: [0, 1, 2].map((payloadIndex) => ({
        payloadIndex,
        channelKind: "test",
        channelName: "test",
        deliveryId: `d${payloadIndex}`,
      })),
    };
    expect(
      forwardedDelivery(delivery, [
        { requestId: "a", optionId: "approve" },
        { requestId: "b", optionId: "cancel" },
      ]),
    ).toEqual({
      ...delivery,
      payloads: [delivery.payloads[1], delivery.payloads[2]],
      deliveryMetadata: [
        { ...delivery.deliveryMetadata[1], payloadIndex: 0 },
        { ...delivery.deliveryMetadata[2], payloadIndex: 1 },
      ],
    });
  });

  it("assigns mixed-payload metadata only to the first child, never to a child when input stays with the parent", () => {
    const a = { requestId: "a", optionId: "approve" };
    const b = { requestId: "b", optionId: "cancel" };
    const delivery = {
      kind: "deliver" as const,
      auth: ALICE,
      payloads: [{ inputResponses: [a, b] }],
      deliveryMetadata: [
        { payloadIndex: 0, channelKind: "test", channelName: "test", deliveryId: "d" },
      ],
    };
    const routed = new Set(["a", "b"]);
    expect(forwardedDelivery(delivery, [a], routed).deliveryMetadata).toEqual(
      delivery.deliveryMetadata,
    );
    expect(forwardedDelivery(delivery, [b], routed).deliveryMetadata).toBeUndefined();
    expect(forwardedDelivery(delivery, [a]).deliveryMetadata).toBeUndefined();
    expect(
      forwardedDelivery(
        { ...delivery, payloads: [{ inputResponses: [a, b], message: "parent" }] },
        [a],
        routed,
      ).deliveryMetadata,
    ).toBeUndefined();
  });

  it("the default authorization handler returns an arrival without modifying the scoped context", async () => {
    const context = new ContextContainer();
    context.set(AuthKey, BOB);
    const result = await effectHandlers({ context }).resumeAuthorization(resume);
    expect(result).toEqual([
      { type: "authorization.resumed", result: resume.result, requester: ALICE },
    ]);
    expect(context.get(AuthKey)).toBe(BOB);
    expect(context.get(PendingAuthorizationResultKey)).toBeUndefined();
  });
});
