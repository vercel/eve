import { randomBytes } from "node:crypto";

import type { SessionStreamEvent } from "eve/client";
import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const STREAMED_ACTION_TOOL = "streamed-action";

interface ChannelSessionResponse {
  readonly sessionId: string;
}

function firstNonEmptyLine(message: string): string | undefined {
  for (const line of message.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function preToolNarration(events: readonly SessionStreamEvent[]): string | undefined {
  const requestIndex = events.findIndex(
    (event) =>
      event.type === "call.requested" && event.data.capability.name === STREAMED_ACTION_TOOL,
  );
  if (requestIndex < 0) return undefined;

  for (let index = requestIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "content.completed" &&
      event.data.phase === "narration" &&
      typeof event.data.value === "string"
    ) {
      return firstNonEmptyLine(event.data.value);
    }
  }
  return undefined;
}

function narratedStreamedActionOrder(events: readonly SessionStreamEvent[]): boolean {
  const requests = events.flatMap((event, eventIndex) =>
    event.type === "call.requested" && event.data.capability.name === STREAMED_ACTION_TOOL
      ? [{ callId: event.data.callId, eventIndex }]
      : [],
  );
  const callIds = new Set(requests.map((request) => request.callId));
  const results = events.flatMap((event, eventIndex) =>
    event.type === "call.settled" &&
    callIds.has(event.data.callId) &&
    event.data.outcome === "completed"
      ? [{ callId: event.data.callId, eventIndex }]
      : [],
  );

  const [request] = requests;
  const [result] = results;
  return (
    request !== undefined &&
    result !== undefined &&
    requests.length === 1 &&
    results.length === 1 &&
    request.callId === result.callId &&
    request.eventIndex < result.eventIndex &&
    preToolNarration(events) !== undefined
  );
}

async function postChannel(
  target: EveEvalTargetHandle,
  path: string,
  body: Record<string, unknown>,
): Promise<ChannelSessionResponse> {
  const response = await target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`POST ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`POST ${path} returned a non-object payload: ${JSON.stringify(payload)}`);
  }

  const sessionId = Reflect.get(payload, "sessionId");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`POST ${path} returned no sessionId: ${JSON.stringify(payload)}`);
  }
  return { sessionId };
}

/**
 * End-to-end channel contract: the adapter receives the pre-tool narration
 * before the matching call request and result.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Channel event smoke: pre-tool narration is visible when an action is requested.",
  async test(t) {
    const token = `channel-narration-${randomBytes(4).toString("hex")}`;
    const started = await postChannel(t.target, "/action-narration/start", {
      message:
        "Before calling `streamed-action`, write one short plain-text sentence explaining the action. " +
        `Then call it exactly once with label "${token}". After it returns, reply with the label verbatim.`,
      token,
    });
    const session = await t.target.attachSession(started.sessionId);
    await t.require(
      preToolNarration(session.events) ?? "",
      satisfies((value: string) => value.length > 0, "pre-tool narration is non-empty"),
    );

    session.eventsSatisfy(
      "pre-tool narration precedes the matching streamed action result",
      narratedStreamedActionOrder,
    );

    session.succeeded();
    t.succeeded();
    t.calledTool(STREAMED_ACTION_TOOL, { count: 1 });
  },
});
