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
import { webChatDriver } from "#internal/testing/channel-conformance/web-chat-driver.js";

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

const TUI_TYPED_APPROVAL =
  "the approval drawer holds the keyboard; a person answers it with y or n";

/**
 * Every first-party channel's and client's place in the HITL contract, keyed by
 * the directory whose `hitl-conformance.integration.test.ts` runs it (`web-chat`
 * runs from `test/browser`, since it needs a browser). Each cell is one of:
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
  discord: [{ driver: discordDriver }],
  github: [{ driver: githubDriver }],
  linear: [{ driver: linearDriver }],
  linq: [{ driver: linqDriver }],
  slack: [{ driver: slackDriver }],
  teams: [{ driver: teamsDriver }],
  telegram: [{ driver: telegramDriver }],
  tui: [
    {
      driver: tuiDriver,
      unsupported: {
        "a text reply of approve runs the gated tool": TUI_TYPED_APPROVAL,
        "a text reply of cancel stops the gated tool without running it": TUI_TYPED_APPROVAL,
      },
    },
  ],
  twilio: [{ driver: twilioDriver }],
  "web-chat": [{ driver: webChatDriver }],
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
