import { describe, expect, it } from "vitest";

import { type HitlRule, hitlContract } from "#internal/testing/channel-conformance/contract.js";
import {
  type ChannelDriver,
  withChannelConversation,
} from "#internal/testing/channel-conformance/harness.js";
import {
  chatSdkDriver,
  chatSdkTextDriver,
} from "#internal/testing/channel-conformance/chat-sdk-driver.js";
import { discordDriver } from "#internal/testing/channel-conformance/discord-driver.js";
import { githubDriver } from "#internal/testing/channel-conformance/github-driver.js";
import { linearDriver } from "#internal/testing/channel-conformance/linear-driver.js";
import { linqDriver } from "#internal/testing/channel-conformance/linq-driver.js";
import { slackDriver } from "#internal/testing/channel-conformance/slack-driver.js";
import { teamsDriver } from "#internal/testing/channel-conformance/teams-driver.js";
import { telegramDriver } from "#internal/testing/channel-conformance/telegram-driver.js";
import { twilioDriver } from "#internal/testing/channel-conformance/twilio-driver.js";

interface BrokenCell {
  readonly reason: string;
  /** Matches the error this rule fails with today. */
  readonly symptom: RegExp;
}

/** Rules that check how an answered prompt's message changes, by prompt kind and how it was answered. */
const answeredPromptRules = {
  approvalPress: [
    "pressing Approve clears the approval's buttons",
    "pressing Approve names who approved on the approval",
  ],
  approvalText: [
    "approving by text clears the approval's buttons",
    "approving by text names who approved on the approval",
  ],
  questionPress: [
    "pressing an option clears the question's buttons",
    "pressing an option names who answered on the question",
  ],
  questionText: [
    "answering a question by text clears its buttons",
    "answering a question by text names who answered on the question",
  ],
} as const satisfies Record<string, readonly HitlRule[]>;

/** Answered prompts in `groups` are never edited, so they keep their buttons and never say who answered. */
function staleAnsweredPrompts(
  reason: string,
  groups: readonly (keyof typeof answeredPromptRules)[],
): Partial<Record<HitlRule, BrokenCell>> {
  return Object.fromEntries(
    groups
      .flatMap((group) => answeredPromptRules[group])
      .map((rule) => [
        rule,
        {
          reason,
          symptom: /the answered prompt (still offers \[".+\]|never names who answered)/,
        },
      ]),
  );
}

/** #4135 regression: Telegram's approval buttons never resume the held turn. */
function heldApprovalPressIgnored(
  rules: readonly HitlRule[],
): Partial<Record<HitlRule, BrokenCell>> {
  return Object.fromEntries(
    rules.map((rule) => [
      rule,
      {
        reason:
          "#4135: a held approval checks the button's callback id before Telegram maps it to the request",
        symptom: /Timed out waiting for deploy_release to run or be denied on telegram/,
      },
    ]),
  );
}

/**
 * Runs the HITL contract against every registered channel driver. Each cell is one of:
 *
 * - must pass;
 * - not supported: the platform lacks a capability the rule requires (skipped);
 * - broken: the channel should pass but doesn't yet. The cell passes only when
 *   the rule fails with the recorded `symptom`, so a fix or an unrelated
 *   failure (such as harness breakage) both turn it red.
 */
const channels: readonly {
  readonly driver: () => ChannelDriver;
  readonly broken?: Partial<Record<HitlRule, BrokenCell>>;
}[] = [
  {
    driver: chatSdkDriver,
    broken: staleAnsweredPrompts("the bridge never edits an answered prompt", [
      "approvalPress",
      "approvalText",
      "questionPress",
      "questionText",
    ]),
  },
  {
    driver: chatSdkTextDriver,
    broken: {
      "a rendered question shows every option a person can choose": {
        reason: "#3712: the card's fallback text is only the prompt",
        symptom: /the question showed \[\]/,
      },
      "a tool approval shows Approve and Cancel": {
        reason: "#3712: the card's fallback text is only the prompt",
        symptom: /the approval showed \[\]/,
      },
    },
  },
  {
    driver: discordDriver,
    broken: staleAnsweredPrompts("a press gets a deferred update and the message is never edited", [
      "approvalPress",
      "questionPress",
    ]),
  },
  { driver: githubDriver },
  { driver: linearDriver },
  { driver: linqDriver },
  {
    driver: slackDriver,
    broken: {
      ...staleAnsweredPrompts(
        "only the button interaction handler edits a question; a typed answer leaves it",
        ["questionText"],
      ),
      "approving by text names who approved on the approval": {
        reason: "the card loses its buttons after a typed approval but doesn't say who approved",
        symptom: /the answered prompt never names who answered/,
      },
    },
  },
  {
    driver: teamsDriver,
    broken: staleAnsweredPrompts(
      "only a pressed approval card is recorded for editing; questions and typed approvals are not",
      ["approvalText", "questionPress", "questionText"],
    ),
  },
  {
    driver: telegramDriver,
    broken: {
      ...staleAnsweredPrompts(
        "nothing edits an answered prompt; a press only answers the callback query",
        ["approvalText", "questionPress", "questionText"],
      ),
      ...heldApprovalPressIgnored([
        "pressing Approve runs the gated tool",
        "pressing Cancel stops the gated tool without running it",
        ...answeredPromptRules.approvalPress,
      ]),
    },
  },
  {
    driver: twilioDriver,
    broken: {
      "a rendered question shows every option a person can choose": {
        reason: "the channel never sends the question (no input.requested handler)",
        symptom: /Timed out waiting for the question "Which day works for the review\?" on twilio/,
      },
      "a text reply matching an option answers the only pending question": {
        reason: "the channel never sends the question (no input.requested handler)",
        symptom: /Timed out waiting for the question "Which day works for the review\?" on twilio/,
      },
      "a tool approval shows Approve and Cancel": {
        reason: "the channel never sends the approval (no input.requested handler)",
        symptom: /Timed out waiting for the question "Approve Deploy release\?" on twilio/,
      },
      "a text reply of approve runs the gated tool": {
        reason: "the channel never sends the approval (no input.requested handler)",
        symptom: /Timed out waiting for the question "Approve Deploy release\?" on twilio/,
      },
      "a text reply of cancel stops the gated tool without running it": {
        reason: "the channel never sends the approval (no input.requested handler)",
        symptom: /Timed out waiting for the question "Approve Deploy release\?" on twilio/,
      },
    },
  },
];

/**
 * A broken cell fails with its symptom, often a wait that never ends, so it gets
 * a short wait. Real platform calls arrive in well under a second once warm.
 */
const BROKEN_WAIT_TIMEOUT_MS = 3_000;

describe.each(channels.map((entry) => ({ ...entry, name: entry.driver().name })))(
  "$name HITL contract",
  ({ driver, broken }) => {
    const { capabilities } = driver();
    for (const rule of hitlContract) {
      const supported = rule.requires.every((capability) => capabilities.includes(capability));
      const known = broken?.[rule.rule];
      if (!supported) {
        it.skip(`${rule.rule} (not supported)`, () => {});
      } else if (known === undefined) {
        it(rule.rule, () => withChannelConversation(driver(), (c) => rule.run(c)), 60_000);
      } else {
        it(
          `${rule.rule} (broken: ${known.reason})`,
          () =>
            expect(
              withChannelConversation(driver(), (c) => rule.run(c), {
                waitTimeoutMs: BROKEN_WAIT_TIMEOUT_MS,
              }),
            ).rejects.toThrow(known.symptom),
          60_000,
        );
      }
    }
  },
);
