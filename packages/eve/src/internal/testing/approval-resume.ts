import { simulateReadableStream } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "#context/keys.js";

export const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1,
  },
  outputTokens: {
    reasoning: undefined,
    text: 1,
    total: 1,
  },
};

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

export function textStreamResult(text: string): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { id: "answer", type: "text-start" },
        { delta: text, id: "answer", type: "text-delta" },
        { id: "answer", type: "text-end" },
        {
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage,
        },
      ] satisfies StreamPart[],
    }),
  };
}

export function toolCallStreamResult(call: {
  readonly input: string;
  readonly toolCallId: string;
  readonly toolName: string;
}): StreamResult {
  return toolCallsStreamResult([call]);
}

export function toolCallsStreamResult(
  calls: readonly {
    readonly input: string;
    readonly toolCallId: string;
    readonly toolName: string;
  }[],
): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        ...calls.map((call) => ({ ...call, type: "tool-call" as const })),
        {
          finishReason: { raw: undefined, unified: "tool-calls" },
          type: "finish",
          usage,
        },
      ] satisfies StreamPart[],
    }),
  };
}

export function createApprovalContext(): ContextContainer {
  const responder = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: "user-1",
    principalType: "user" as const,
  };
  const ctx = new ContextContainer();
  ctx.set(AuthKey, responder);
  ctx.set(SessionIdKey, "generate-approval-resume-session");
  ctx.set(SessionKey, {
    auth: { current: responder, initiator: null },
    sessionId: "generate-approval-resume-session",
    turn: { id: "turn-1", sequence: 1 },
  });
  return ctx;
}
