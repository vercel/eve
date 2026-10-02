import { describe, expect, it } from "vitest";

import {
  type ContractRule,
  type HitlRule,
  hitlContract,
} from "#internal/testing/channel-conformance/contract.js";
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

/** Rules that check how an answered prompt's message changes, by prompt kind and how it was answered. */
const answeredPromptRules = {
  approvalPress: {
    cleared: "pressing Approve clears the approval's buttons",
    named: "pressing Approve names who approved on the approval",
  },
  approvalText: {
    cleared: "approving by text clears the approval's buttons",
    named: "approving by text names who approved on the approval",
  },
  questionPress: {
    cleared: "pressing an option clears the question's buttons",
    named: "pressing an option names who answered on the question",
  },
  questionText: {
    cleared: "answering a question by text clears its buttons",
    named: "answering a question by text names who answered on the question",
  },
} as const satisfies Record<string, { readonly cleared: HitlRule; readonly named: HitlRule }>;

type AnsweredPrompt = keyof typeof answeredPromptRules;

/** Answered prompts in `groups` are never edited, so they keep their buttons and never say who answered. */
function staleAnsweredPrompts(
  reason: string,
  groups: readonly AnsweredPrompt[],
): Partial<Record<HitlRule, BrokenCell>> {
  return Object.fromEntries(
    groups
      .flatMap((group) => Object.values(answeredPromptRules[group]))
      .map((rule) => [
        rule,
        {
          reason,
          symptom: /the answered prompt (still offers \[".+\]|never names who answered)/,
        },
      ]),
  );
}

/** Answered prompts in `groups` lose their buttons, but the edit doesn't say who answered. */
function unnamedAnsweredPrompts(
  reason: string,
  groups: readonly AnsweredPrompt[],
): Partial<Record<HitlRule, BrokenCell>> {
  return Object.fromEntries(
    groups.map((group) => [
      answeredPromptRules[group].named,
      { reason, symptom: /the answered prompt never names who answered/ },
    ]),
  );
}

interface ConformanceChannel {
  readonly driver: () => ChannelDriver | ClientDriver;
  /**
   * A DM column beside the channel's shared-thread column. It runs only rules
   * whose behavior varies by conversation; the shared column covers the rest.
   */
  readonly dm?: true;
  readonly broken?: Partial<Record<HitlRule, BrokenCell>>;
  /** Rules this client deliberately doesn't offer, with why, beyond what its capabilities rule out. */
  readonly unsupported?: Partial<Record<HitlRule, string>>;
}

const UNNAMED_RESPONDER =
  "a resolved prompt doesn't say who answered; input.resolved carries no responder";

const CHAT_SDK_BROKEN = unnamedAnsweredPrompts(UNNAMED_RESPONDER, [
  "approvalPress",
  "approvalText",
  "questionPress",
  "questionText",
]);

const DISCORD_BROKEN = unnamedAnsweredPrompts(UNNAMED_RESPONDER, [
  "approvalPress",
  "questionPress",
]);

const SLACK_BROKEN = {
  ...staleAnsweredPrompts(
    "only the button interaction handler edits a question; a typed answer leaves it",
    ["questionText"],
  ),
  "approving by text names who approved on the approval": {
    reason: "the card loses its buttons after a typed approval but doesn't say who approved",
    symptom: /the answered prompt never names who answered/,
  },
} satisfies Partial<Record<HitlRule, BrokenCell>>;

const TEAMS_BROKEN = unnamedAnsweredPrompts(UNNAMED_RESPONDER, [
  "approvalText",
  "questionPress",
  "questionText",
]);

const TELEGRAM_BROKEN = unnamedAnsweredPrompts(UNNAMED_RESPONDER, [
  "approvalPress",
  "approvalText",
  "questionPress",
  "questionText",
]);

const TUI_TYPED_APPROVAL =
  "the approval drawer holds the keyboard; a person answers it with y or n";
const TUI_SINGLE_PERSON = "one person answers at their own terminal; there's nobody else to tell";

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
  "chat-sdk": [{ driver: chatSdkDriver, broken: CHAT_SDK_BROKEN }, { driver: chatSdkTextDriver }],
  "chat-sdk-dm": [{ dm: true, driver: () => chatSdkDriver("private"), broken: CHAT_SDK_BROKEN }],
  discord: [{ driver: discordDriver, broken: DISCORD_BROKEN }],
  "discord-dm": [{ dm: true, driver: () => discordDriver("private"), broken: DISCORD_BROKEN }],
  github: [{ driver: githubDriver }],
  linear: [{ driver: linearDriver }],
  linq: [{ driver: linqDriver }],
  "linq-dm": [{ dm: true, driver: () => linqDriver("private") }],
  slack: [{ driver: slackDriver, broken: SLACK_BROKEN }],
  "slack-dm": [{ dm: true, driver: () => slackDriver("private"), broken: SLACK_BROKEN }],
  teams: [{ driver: teamsDriver, broken: TEAMS_BROKEN }],
  "teams-dm": [{ dm: true, driver: () => teamsDriver("private"), broken: TEAMS_BROKEN }],
  telegram: [{ driver: telegramDriver, broken: TELEGRAM_BROKEN }],
  "telegram-dm": [{ dm: true, driver: () => telegramDriver("private"), broken: TELEGRAM_BROKEN }],
  tui: [
    {
      driver: tuiDriver,
      unsupported: {
        "pressing an option of an answered question sends it to the agent as new input":
          "an answered question's drawer closes, so nothing is left to press",
        "a text reply of approve runs the gated tool": TUI_TYPED_APPROVAL,
        "a text reply of cancel stops the gated tool without running it": TUI_TYPED_APPROVAL,
        "approving by text clears the approval's buttons": TUI_TYPED_APPROVAL,
        "approving by text names who approved on the approval": TUI_TYPED_APPROVAL,
        "pressing Approve names who approved on the approval": TUI_SINGLE_PERSON,
        "pressing an option names who answered on the question": TUI_SINGLE_PERSON,
        "answering a question by text names who answered on the question": TUI_SINGLE_PERSON,
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

/** How one channel or client stands on one rule. */
type Cell =
  | { readonly kind: "pass" }
  | { readonly kind: "unsupported"; readonly reason?: string }
  | { readonly kind: "broken"; readonly broken: BrokenCell };

function cellOf(entry: ConformanceChannel, rule: (typeof hitlContract)[number]): Cell {
  if (entry.dm === true && (rule as ContractRule).variesByConversation !== true) {
    return {
      kind: "unsupported",
      reason:
        "it doesn't vary between a shared thread and a DM, and the shared-thread column covers it",
    };
  }
  const { capabilities } = entry.driver();
  if (!rule.requires.every((capability) => capabilities.includes(capability))) {
    return { kind: "unsupported" };
  }
  const declined = entry.unsupported?.[rule.rule];
  if (declined !== undefined) return { kind: "unsupported", reason: declined };
  const broken = entry.broken?.[rule.rule];
  return broken === undefined ? { kind: "pass" } : { kind: "broken", broken };
}

/**
 * Declares the HITL contract cells for one channel directory. Each channel gets
 * its own test file because conversations can't overlap within a process, and
 * separate files let vitest run channels in parallel workers.
 */
export function describeHitlConformance(channel: keyof typeof hitlConformance): void {
  const entries: readonly ConformanceChannel[] = hitlConformance[channel];
  describe.each(entries.map((entry) => ({ entry, name: entry.driver().name })))(
    "$name HITL contract",
    ({ entry }) => {
      for (const rule of hitlContract) {
        const cell = cellOf(entry, rule);
        const run = (options?: { readonly waitTimeoutMs: number }) =>
          withChannelConversation(entry.driver(), (c) => rule.run(c), options);
        if (cell.kind === "unsupported") {
          const why = cell.reason === undefined ? "" : `: ${cell.reason}`;
          it.skip(`${rule.rule} (not supported${why})`, () => {});
        } else if (cell.kind === "pass") {
          it(rule.rule, () => run(), 60_000);
        } else {
          it(
            `${rule.rule} (broken: ${cell.broken.reason})`,
            () =>
              expect(run({ waitTimeoutMs: BROKEN_WAIT_TIMEOUT_MS })).rejects.toThrow(
                cell.broken.symptom,
              ),
            60_000,
          );
        }
      }
    },
  );
}

const MATRIX_SYMBOLS = { broken: "❌", pass: "✅", unsupported: "—" } as const;

/**
 * Renders every channel's and client's cell for every rule as Markdown. The
 * suite holds each cell to what this table says, so the rendered matrix is
 * current whenever the suite passes.
 */
export function renderHitlConformanceMatrix(): string {
  const entries = Object.values(hitlConformance).flatMap(
    (group): readonly ConformanceChannel[] => group,
  );
  const names = entries.map((entry) => entry.driver().name);
  const escape = (text: string) => text.replaceAll("|", "\\|");
  const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const notes = (kind: "broken" | "unsupported") =>
    entries.flatMap((entry, index) =>
      hitlContract.flatMap((rule) => {
        const cell = cellOf(entry, rule);
        if (cell.kind !== kind) return [];
        const reason = cell.kind === "broken" ? cell.broken.reason : cell.reason;
        return reason === undefined ? [] : [`- **${names[index]}**, ${rule.rule}: ${reason}`];
      }),
    );
  return [
    "# HITL conformance matrix",
    "",
    "<!-- Generated from conformance.ts by matrix.test.ts. Do not edit by hand. -->",
    "",
    "Each channel and client against each rule in [`contract.ts`](./contract.ts), as",
    "[`conformance.ts`](./conformance.ts) records it. The suite holds every cell to this",
    "table: a ✅ cell must pass, and a ❌ cell passes only while the rule fails with its",
    "recorded symptom. Regenerate it after changing either file:",
    "",
    "```sh",
    "pnpm --filter eve exec vitest run --config vitest.unit.config.ts channel-conformance/matrix -u",
    "```",
    "",
    "✅ passes · ❌ broken · — not supported (the platform lacks a capability the rule",
    "needs, or the client declines it below)",
    "",
    row(["Rule", ...names.map((name) => `\`${name}\``)]),
    row(["---", ...names.map(() => ":---:")]),
    ...hitlContract.map((rule) =>
      row([
        // Non-breaking spaces keep each rule on one line; GitHub scrolls the table instead.
        escape(rule.rule).replaceAll(" ", "\u00a0"),
        ...entries.map((entry) => MATRIX_SYMBOLS[cellOf(entry, rule).kind]),
      ]),
    ),
    "",
    "## Broken",
    "",
    ...notes("broken").map(escape),
    "",
    "## Declined",
    "",
    ...notes("unsupported").map(escape),
    "",
  ].join("\n");
}
