import { randomBytes } from "node:crypto";

import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

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
 * before the matching action request, then exposes that observation to the
 * next model step.
 */
export default defineEval({
  description: "Channel event smoke: pre-tool narration is visible when an action is requested.",
  async test(t) {
    const token = `channel-narration-${randomBytes(4).toString("hex")}`;
    const started = await postChannel(t.target, "/action-narration/start", {
      message:
        "Before calling `streamed-action`, write one short plain-text sentence explaining the action. " +
        `Then call it exactly once with label "${token}". After it returns, call ` +
        `\`${OBSERVATION_TOOL}\` exactly once. Finally, reply with the label verbatim.`,
      token,
    });
    const session = await t.target.attachSession(started.sessionId);
    const narration = await t.require(
      preToolNarration(session.events) ?? "",
      satisfies((value: string) => value.length > 0, "pre-tool narration is non-empty"),
    );

    session.event("action.result", {
      count: 1,
      data: {
        result: {
          kind: "tool-result",
          output: { narration },
          toolName: OBSERVATION_TOOL,
        },
        status: "completed",
      },
    });

    session.succeeded();
    t.succeeded();
    t.calledTool(STREAMED_ACTION_TOOL, { count: 1 });
  },
});
