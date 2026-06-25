import { randomBytes } from "node:crypto";

import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval, type EveEvalTargetHandle } from "eve/evals";

const STREAMED_ACTION_TOOL = "streamed-action";
const OBSERVATION_TOOL = "read-channel-action-narration";

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

function preToolNarration(events: readonly HandleMessageStreamEvent[]): string | undefined {
  const actionRequestIndex = events.findIndex(
    (event) =>
      event.type === "actions.requested" &&
      event.data.actions.some(
        (action) => action.kind === "tool-call" && action.toolName === STREAMED_ACTION_TOOL,
      ),
  );
  if (actionRequestIndex < 0) return undefined;

  for (let index = actionRequestIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "message.completed" &&
      event.data.finishReason === "tool-calls" &&
      event.data.message !== null
    ) {
      return firstNonEmptyLine(event.data.message);
    }
  }
  return undefined;
}

function observedNarration(events: readonly HandleMessageStreamEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") continue;
    if (event.data.result.toolName !== OBSERVATION_TOOL) continue;

    const output = event.data.result.output;
    if (typeof output !== "object" || output === null || Array.isArray(output)) continue;
    const narration = Reflect.get(output, "narration");
    if (typeof narration === "string" && narration.length > 0) return narration;
  }
  return undefined;
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
 * End-to-end channel contract: the adapter receives the pre-tool completion
 * before the matching action request, then preserves its observation across
 * the next inbound channel turn.
 */
export default defineEval({
  description: "Channel event smoke: pre-tool narration is visible when an action is requested.",
  async test(t) {
    const token = `channel-narration-${randomBytes(4).toString("hex")}`;
    const started = await postChannel(t.target, "/action-narration/start", {
      message:
        "Before calling `streamed-action`, write one short plain-text sentence explaining the action. " +
        `Then call it exactly once with label "${token}". After it returns, reply with the label verbatim.`,
      token,
    });
    const firstTurn = await t.target.attachSession(started.sessionId);
    const narration = preToolNarration(firstTurn.events);
    if (narration === undefined) {
      throw new Error(
        "Expected a non-empty tool-calls message.completed event before the streamed-action request.",
      );
    }

    const continued = await postChannel(t.target, "/action-narration/continue", {
      message: `Call \`${OBSERVATION_TOOL}\` exactly once, then reply with the narration value it returned.`,
      token,
    });
    if (continued.sessionId !== started.sessionId) {
      throw new Error(
        `Expected the channel continuation to resume ${started.sessionId}, received ${continued.sessionId}.`,
      );
    }

    const secondTurn = await t.target.attachSession(continued.sessionId, {
      startIndex: firstTurn.events.length,
    });
    const observed = observedNarration(secondTurn.events);
    if (observed !== narration) {
      throw new Error(
        `Expected the channel to observe ${JSON.stringify(narration)}, received ${JSON.stringify(observed)}.`,
      );
    }

    t.didNotFail();
    t.completed();
    t.calledTool(STREAMED_ACTION_TOOL, { isError: false, times: 1 });
    t.calledTool(OBSERVATION_TOOL, { isError: false, times: 1 });
  },
});
