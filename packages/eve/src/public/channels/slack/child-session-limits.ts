import {
  SESSION_LIMIT_CONTINUE_OPTION_ID,
  SESSION_LIMIT_STOP_OPTION_ID,
} from "#harness/session-limit-continuation.js";
import { SLACK_BLOCK_KIT_ACTION_VALUE_MAX_LENGTH } from "#public/channels/slack/limits.js";
import { parseInputResponse, type ValidatedInputResponse } from "#shared/input.js";

/** One Slack card intentionally stays well below the 2,000-character action-value cap. */
export const CHILD_SESSION_LIMIT_GROUP_MAX_SIZE = 25;
export const CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID =
  "eve_input:child-session-limit:approve-all";
export const CHILD_SESSION_LIMIT_STOP_TURN_ACTION_ID = "eve_input:child-session-limit:stop-turn";

interface SlackChildSessionLimitAction {
  readonly actionId: string;
  readonly value?: string;
}

interface ChildSessionLimitActionValue {
  readonly groupId: string;
  readonly requestIds: readonly string[];
  readonly revision: number;
}

export type ChildSessionLimitGroupOptionId =
  | typeof SESSION_LIMIT_CONTINUE_OPTION_ID
  | typeof SESSION_LIMIT_STOP_OPTION_ID;

export interface DerivedChildSessionLimitGroupResponse {
  readonly groupId: string;
  readonly optionId: ChildSessionLimitGroupOptionId;
  readonly responses: readonly ValidatedInputResponse[];
  readonly revision: number;
}

export interface ChildSessionLimitGroupSubmission {
  readonly messageTs?: string;
  readonly optionId: ChildSessionLimitGroupOptionId;
  readonly revision: number;
}

export function childSessionLimitGroupFitsSlack(input: ChildSessionLimitActionValue): boolean {
  return (
    input.requestIds.length > 0 &&
    input.requestIds.length <= CHILD_SESSION_LIMIT_GROUP_MAX_SIZE &&
    JSON.stringify(input).length <= SLACK_BLOCK_KIT_ACTION_VALUE_MAX_LENGTH
  );
}

/** Builds one compact card whose action snapshots the currently paused children. */
export function buildChildSessionLimitGroupPost(input: ChildSessionLimitActionValue): {
  readonly blocks: readonly unknown[];
  readonly text: string;
} {
  const count = input.requestIds.length;
  if (count === 0 || count > CHILD_SESSION_LIMIT_GROUP_MAX_SIZE) {
    throw new Error(
      `Child session-limit groups must contain 1-${CHILD_SESSION_LIMIT_GROUP_MAX_SIZE} requests.`,
    );
  }

  const value = JSON.stringify(input);
  if (!childSessionLimitGroupFitsSlack(input)) {
    throw new Error("Child session-limit group action exceeds Slack's value limit.");
  }

  const text = `${String(count)} child session${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} more tokens`;
  return {
    blocks: [
      {
        type: "card",
        body: { type: "mrkdwn", text: `*${text}*`, verbatim: false },
        subtext: {
          type: "mrkdwn",
          text: "Approve all grants each paused child one fresh token window. Stop turn ends the parent turn.",
          verbatim: false,
        },
        actions: [
          {
            type: "button",
            action_id: CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID,
            text: { type: "plain_text", text: "Approve all", emoji: false },
            style: "primary",
            value,
          },
          {
            type: "button",
            action_id: CHILD_SESSION_LIMIT_STOP_TURN_ACTION_ID,
            text: { type: "plain_text", text: "Stop turn", emoji: false },
            style: "danger",
            value,
          },
        ],
      },
    ],
    text,
  };
}

/** Decodes an Approve all click into one ordinary continuation per child request. */
export function deriveChildSessionLimitGroupResponse(
  action: SlackChildSessionLimitAction,
): DerivedChildSessionLimitGroupResponse | null {
  if (
    (action.actionId !== CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID &&
      action.actionId !== CHILD_SESSION_LIMIT_STOP_TURN_ACTION_ID) ||
    action.value === undefined
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(action.value);
  } catch {
    return null;
  }
  if (!isChildSessionLimitActionValue(parsed)) return null;

  const optionId =
    action.actionId === CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID
      ? SESSION_LIMIT_CONTINUE_OPTION_ID
      : SESSION_LIMIT_STOP_OPTION_ID;

  return {
    groupId: parsed.groupId,
    optionId,
    responses: parsed.requestIds.map((requestId) =>
      parseInputResponse({
        optionId,
        requestId,
      }),
    ),
    revision: parsed.revision,
  };
}

/** Renders the terminal state after the latest group generation is claimed. */
export function buildSettledChildSessionLimitGroupPost(input: {
  readonly count: number;
  readonly optionId: ChildSessionLimitGroupOptionId;
}): { readonly blocks: readonly unknown[]; readonly text: string } {
  const subject = `${String(input.count)} child session${input.count === 1 ? "" : "s"}`;
  const approved = input.optionId === SESSION_LIMIT_CONTINUE_OPTION_ID;
  const text = approved ? `Approved ${subject}` : `Stopped parent turn with ${subject} paused`;
  return {
    blocks: [
      {
        type: "card",
        body: { type: "mrkdwn", text: `*${subject} needed more tokens*`, verbatim: false },
        subtext: {
          type: "mrkdwn",
          text: approved ? "Approved all paused children." : "Stopped the parent turn.",
          verbatim: false,
        },
      },
    ],
    text,
  };
}

function isChildSessionLimitActionValue(value: unknown): value is ChildSessionLimitActionValue {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ChildSessionLimitActionValue>;
  if (
    typeof candidate.groupId !== "string" ||
    candidate.groupId.length === 0 ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision ?? 0) < 1 ||
    !Array.isArray(candidate.requestIds) ||
    candidate.requestIds.length === 0 ||
    candidate.requestIds.length > CHILD_SESSION_LIMIT_GROUP_MAX_SIZE
  ) {
    return false;
  }
  const requestIds = candidate.requestIds;
  return (
    requestIds.every((requestId) => typeof requestId === "string" && requestId.length > 0) &&
    new Set(requestIds).size === requestIds.length
  );
}
