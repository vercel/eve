import { expect, it } from "vitest";
import { resolveInvokeOperation } from "#cli/invoke/invoke.js";
import { parseInvokeResumeInput, type InvokeResult } from "#cli/invoke/result.js";

const completed: InvokeResult = {
  status: "completed",
  sessionEnded: false,
  reply: "Finished.",
  interactions: [],
  resume: {
    deliveryId: "delivery-original",
    session: { sessionId: "session-1", streamIndex: 7 },
    target: { kind: "remote", serverUrl: "https://example.com/" },
  },
};

it("allows a follow-up after request completion without treating its session as ended", () => {
  expect(resolveInvokeOperation({ previous: completed, prompt: "Next task" })).toEqual({
    kind: "send",
    payload: { message: "Next task" },
    resume: completed.resume,
  });
  expect(() =>
    resolveInvokeOperation({ previous: { ...completed, sessionEnded: true }, prompt: "Next task" }),
  ).toThrow("session has ended");
});

it("follows the original delivery when a working invocation is resumed", () => {
  const working: InvokeResult = { ...completed, status: "working", reply: undefined };
  expect(resolveInvokeOperation({ previous: working })).toEqual({
    kind: "follow",
    resume: completed.resume,
  });
  expect(() => resolveInvokeOperation({ previous: working, prompt: "Another task" })).toThrow(
    "working invocation",
  );
});

it("polls sign-ins but requires an answer for other awaiting-input interactions", () => {
  const waiting: InvokeResult = {
    ...completed,
    status: "awaiting-input",
    reply: undefined,
    interactions: [
      {
        interactionId: "sign-in-1",
        status: "open",
        turnId: "turn-1",
        stepIndex: 0,
        request: {
          kind: "sign-in",
          prompt: "Connect your calendar.",
          signIn: { name: "calendar", url: "https://example.com/connect" },
        },
      },
    ],
  };
  expect(resolveInvokeOperation({ previous: waiting })).toEqual({
    kind: "follow",
    resume: completed.resume,
  });
  const question: InvokeResult = {
    ...waiting,
    interactions: [
      {
        ...waiting.interactions[0]!,
        request: { kind: "question", prompt: "Which calendar?", allowFreeform: true },
      },
    ],
  };
  expect(() => resolveInvokeOperation({ previous: question })).toThrow("waiting for an answer");
  expect(resolveInvokeOperation({ previous: question, prompt: "Alice's calendar" })).toEqual({
    kind: "send",
    payload: { message: "Alice's calendar" },
    resume: completed.resume,
  });
});

it("requires delivery identity and excludes credentials from resumable JSON", () => {
  expect(parseInvokeResumeInput(completed)).toEqual(completed);
  expect(() =>
    parseInvokeResumeInput({
      ...completed,
      resume: { ...completed.resume, deliveryId: undefined },
    }),
  ).toThrow("not a valid resumable");
  expect(() =>
    parseInvokeResumeInput({
      ...completed,
      resume: { ...completed.resume, headers: { Authorization: "not-a-credential" } },
    }),
  ).toThrow("not a valid resumable");
});
