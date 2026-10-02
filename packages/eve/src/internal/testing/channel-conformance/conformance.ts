import { describe, expect, it } from "vitest";

import { type HitlRule, hitlContract } from "#internal/testing/channel-conformance/contract.js";
import {
  type ChannelDriver,
  type ClientDriver,
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
import { tuiDriver } from "#internal/testing/channel-conformance/tui-driver.js";
import { twilioDriver } from "#internal/testing/channel-conformance/twilio-driver.js";

export interface BrokenCell {
  readonly reason: string;
  /** Matches the error this rule fails with today. */
  readonly symptom: RegExp;
}

interface ConformanceChannel {
  readonly driver: () => ChannelDriver | ClientDriver;
  readonly broken?: Partial<Record<HitlRule, BrokenCell>>;
  /** Rules this client deliberately doesn't offer, with why, beyond what its capabilities rule out. */
  readonly unsupported?: Partial<Record<HitlRule, string>>;
}

const DISCORD_ALIAS: BrokenCell = {
  reason:
    "a press finds the session by its message id, and only the first message the bot posts is aliased to the session",
  symptom: /Timed out waiting for \w+ to (return|run or be denied) on discord/,
};

const TUI_TYPED_APPROVAL =
  "the approval drawer holds the keyboard; a person answers it with y or n";

/**
 * Every first-party channel's and client's place in the HITL contract, keyed by
 * the directory whose `hitl-conformance.integration.test.ts` runs it. Each cell is
 * one of:
 *
 * - must pass;
 * - not supported: the platform lacks a capability the rule requires, or the
 *   entry declines the rule as `unsupported` (skipped);
 * - broken: the channel should pass but doesn't yet. The cell passes only when
 *   the rule fails with the recorded `symptom`, so a fix or an unrelated
 *   failure (such as harness breakage) both turn it red.
 */
const hitlConformance = {
  "chat-sdk": [{ driver: chatSdkDriver }, { driver: chatSdkTextDriver }],
  discord: [
    {
      driver: discordDriver,
      broken: {
        "pressing options of two pending questions answers each with its own option": DISCORD_ALIAS,
        "pressing Approve on one of two pending approvals runs only that tool": DISCORD_ALIAS,
        "answering an approval and a question pending together settles both": DISCORD_ALIAS,
      },
    },
  ],
  github: [{ driver: githubDriver }],
  linear: [{ driver: linearDriver }],
  linq: [{ driver: linqDriver }],
  slack: [{ driver: slackDriver }],
  teams: [{ driver: teamsDriver }],
  telegram: [
    {
      driver: telegramDriver,
      broken: {
        "pressing an option of an answered question sends it to the agent as new input": {
          reason:
            "the first press consumes the button's callback id, so a later press is acknowledged and dropped",
          symptom: /Timed out waiting for a reply to "Saturday" on telegram/,
        },
      },
    },
  ],
  tui: [
    {
      driver: tuiDriver,
      unsupported: {
        "pressing an option of an answered question sends it to the agent as new input":
          "an answered question's drawer closes, so nothing is left to press",
        "a text reply of approve runs the gated tool": TUI_TYPED_APPROVAL,
        "a text reply of cancel stops the gated tool without running it": TUI_TYPED_APPROVAL,
      },
    },
  ],
  twilio: [{ driver: twilioDriver }],
} satisfies Record<string, readonly ConformanceChannel[]>;

/**
 * A broken cell fails with its symptom, often a wait that never ends, so it gets
 * a short wait. Real platform calls arrive in well under a second once warm.
 */
const BROKEN_WAIT_TIMEOUT_MS = 3_000;

/**
 * Declares the HITL contract cells for one channel directory. Each channel gets
 * its own test file because conversations can't overlap within a process, and
 * separate files let vitest run channels in parallel workers.
 */
export function describeHitlConformance(channel: keyof typeof hitlConformance): void {
  const entries: readonly ConformanceChannel[] = hitlConformance[channel];
  describe.each(entries.map((entry) => ({ ...entry, name: entry.driver().name })))(
    "$name HITL contract",
    ({ driver, broken, unsupported }) => {
      const { capabilities } = driver();
      for (const rule of hitlContract) {
        const supported = rule.requires.every((capability) => capabilities.includes(capability));
        const known = broken?.[rule.rule];
        const declined = unsupported?.[rule.rule];
        if (!supported) {
          it.skip(`${rule.rule} (not supported)`, () => {});
        } else if (declined !== undefined) {
          it.skip(`${rule.rule} (not supported: ${declined})`, () => {});
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
}
