import { describe, expect, it } from "vitest";

import {
  type ContractRule,
  type ContractRuleName,
  channelContract,
  channelContractSections,
} from "#internal/testing/channel-conformance/contract.js";
import {
  type ChannelCapability,
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
import { photonDriver } from "#internal/testing/channel-conformance/photon-driver.js";
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
} as const satisfies Record<
  string,
  { readonly cleared: ContractRuleName; readonly named: ContractRuleName }
>;

type AnsweredPrompt = keyof typeof answeredPromptRules;

/** Answered prompts in `groups` are never edited, so they keep their buttons and never say who answered. */
function staleAnsweredPrompts(
  reason: string,
  groups: readonly AnsweredPrompt[],
): Partial<Record<ContractRuleName, BrokenCell>> {
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
): Partial<Record<ContractRuleName, BrokenCell>> {
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
  readonly broken?: Partial<Record<ContractRuleName, BrokenCell>>;
  /** Rules this client deliberately doesn't offer, with why, beyond what its capabilities rule out. */
  readonly unsupported?: Partial<Record<ContractRuleName, string>>;
}

const SIGN_IN_NOT_SHOWN = /Timed out waiting for the bot to show/u;

/** The channel has no default sign-in `interaction.opened` renderer, so a sign-in shows nothing. */
function noSignInRenderer(
  ...rules: ContractRuleName[]
): Partial<Record<ContractRuleName, BrokenCell>> {
  return Object.fromEntries(
    rules.map((rule) => [
      rule,
      { reason: "the channel has no default sign-in renderer", symptom: SIGN_IN_NOT_SHOWN },
    ]),
  );
}

/**
 * Linq's group sign-in can't reach the person privately: its `openDM` needs a phone
 * handle, and a message names its sender only by the handle's opaque id.
 */
const LINQ_SIGN_IN_NOT_PRIVATE = Object.fromEntries(
  [
    "a sign-in names the service and shows its sign-in link",
    "a sign-in shows its confirmation code",
    "a sign-in without a link shows its instructions",
  ].map((rule) => [
    rule,
    {
      reason:
        "Linq's openDM needs the person's phone handle, but a message names its sender by an opaque handle id, so the bot can only say to continue in a direct message",
      symptom: SIGN_IN_NOT_SHOWN,
    },
  ]),
) satisfies Partial<Record<ContractRuleName, BrokenCell>>;

const UNNAMED_RESPONDER =
  "a resolved prompt doesn't say who answered; input.resolved carries no responder";

const CHAT_SDK_BROKEN = {
  ...unnamedAnsweredPrompts(UNNAMED_RESPONDER, [
    "approvalPress",
    "approvalText",
    "questionPress",
    "questionText",
  ]),
};

const DISCORD_BROKEN = {
  ...unnamedAnsweredPrompts(UNNAMED_RESPONDER, ["approvalPress", "questionPress"]),
  ...noSignInRenderer(
    "a sign-in names the service and shows its sign-in link",
    "a sign-in shows its confirmation code",
    "a sign-in without a link shows its instructions",
    "completing a sign-in tells the person it succeeded",
  ),
};

const DISCORD_UNSUPPORTED = {
  "a file sent earlier in the conversation is still there on a later message":
    "each slash command starts its own session, so no later message shares one with the file",
} satisfies Partial<Record<ContractRuleName, string>>;

const SLACK_BROKEN = {
  ...staleAnsweredPrompts(
    "only the button interaction handler edits a question; a typed answer leaves it",
    ["questionText"],
  ),
  "text replies answer two pending approvals one at a time, in the order shown": {
    reason:
      "one card shows every approval a step raises, so a typed reply can't say which it answers",
    symptom: /were shown in one message, so a typed reply can't say which it answers/,
  },
} satisfies Partial<Record<ContractRuleName, BrokenCell>>;

const TEAMS_BROKEN = {
  ...unnamedAnsweredPrompts(UNNAMED_RESPONDER, ["approvalText", "questionPress", "questionText"]),
} satisfies Partial<Record<ContractRuleName, BrokenCell>>;

/** The sign-in prompt, link included, goes to the whole thread. */
const SIGN_IN_LINK_POSTED_TO_THREAD = {
  "only the person signing in sees the sign-in link and code": {
    reason: "the sign-in prompt, link included, is posted to the whole thread",
    symptom: /a message everyone sees carried the sign-in (link|code)/u,
  },
} satisfies Partial<Record<ContractRuleName, BrokenCell>>;

const TELEGRAM_BROKEN = {
  ...unnamedAnsweredPrompts(UNNAMED_RESPONDER, [
    "approvalPress",
    "approvalText",
    "questionPress",
    "questionText",
  ]),
};

const TUI_TYPED_APPROVAL =
  "the approval drawer holds the keyboard; a person answers it with y or n";
const TUI_TYPED_REPLIES =
  "each open request has its own drawer, and typing a message dismisses them all";
const TUI_SINGLE_PERSON = "one person answers at their own terminal; there's nobody else to tell";
const WEB_CHAT_SINGLE_PERSON =
  "one person answers in their own browser tab; there's nobody else to tell";

/**
 * Every first-party channel's and client's place in the channel contract, keyed by
 * the directory whose `conformance.integration.test.ts` runs it (`web-chat`
 * runs from `test/browser`, since it needs a browser). Each cell is one of:
 *
 * - must pass;
 * - not supported: the platform lacks a capability the rule requires, or the
 *   entry declines the rule as `unsupported` (skipped);
 * - broken: the channel should pass but doesn't yet. The cell passes only when
 *   the rule fails with the recorded `symptom`, so a fix or an unrelated
 *   failure (such as harness breakage) both turn it red.
 */
const channelConformance = {
  "chat-sdk": [{ driver: chatSdkDriver, broken: CHAT_SDK_BROKEN }, { driver: chatSdkTextDriver }],
  "chat-sdk-dm": [{ dm: true, driver: () => chatSdkDriver("private"), broken: CHAT_SDK_BROKEN }],
  discord: [{ driver: discordDriver, broken: DISCORD_BROKEN, unsupported: DISCORD_UNSUPPORTED }],
  "discord-dm": [
    {
      dm: true,
      driver: () => discordDriver("private"),
      broken: DISCORD_BROKEN,
      unsupported: DISCORD_UNSUPPORTED,
    },
  ],
  github: [
    {
      driver: githubDriver,
      broken: {
        ...noSignInRenderer(
          "a sign-in without a link shows its instructions",
          "completing a sign-in tells the person it succeeded",
          "message after ignored sign-in tells user it was cancelled",
        ),
      },
    },
  ],
  linear: [
    {
      driver: linearDriver,
      broken: {
        "only the person signing in sees the sign-in link and code": {
          reason:
            "the code is in the elicitation body the whole issue sees; who sees the auth signal's link is unverified",
          symptom: /a message everyone sees carried the sign-in (link|code)/u,
        },
      },
    },
  ],
  linq: [{ driver: linqDriver, broken: LINQ_SIGN_IN_NOT_PRIVATE }],
  "linq-dm": [{ dm: true, driver: () => linqDriver("private") }],
  photon: [{ driver: photonDriver }],
  slack: [{ driver: slackDriver, broken: SLACK_BROKEN }],
  "slack-dm": [{ dm: true, driver: () => slackDriver("private"), broken: SLACK_BROKEN }],
  teams: [{ driver: teamsDriver, broken: { ...TEAMS_BROKEN, ...SIGN_IN_LINK_POSTED_TO_THREAD } }],
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
        "a message while an approval is pending cancels it, so typing approve afterwards runs nothing and the next message gets a reply":
          TUI_TYPED_APPROVAL,
        "pressing Approve on an approval a message cancelled runs nothing": TUI_TYPED_APPROVAL,
        "the requester typing approve on a requester-only approval runs the tool":
          TUI_TYPED_APPROVAL,
        "pressing Approve names who approved on the approval": TUI_SINGLE_PERSON,
        "pressing an option names who answered on the question": TUI_SINGLE_PERSON,
        "answering a question by text names who answered on the question": TUI_SINGLE_PERSON,
        "text replies answer two pending questions one at a time, in the order shown":
          TUI_TYPED_REPLIES,
        "text replies answer two pending approvals one at a time, in the order shown":
          TUI_TYPED_APPROVAL,
        "text replies answer a question and an approval raised together, in the order shown":
          TUI_TYPED_APPROVAL,
      },
    },
  ],
  twilio: [{ driver: twilioDriver }],
  "web-chat": [
    {
      driver: webChatDriver,
      unsupported: {
        "pressing an option of an answered question sends it to the agent as new input":
          "an answered question disables its options, so nothing is left to press",
        "pressing Approve names who approved on the approval": WEB_CHAT_SINGLE_PERSON,
        "approving by text names who approved on the approval": WEB_CHAT_SINGLE_PERSON,
        "pressing an option names who answered on the question": WEB_CHAT_SINGLE_PERSON,
        "answering a question by text names who answered on the question": WEB_CHAT_SINGLE_PERSON,
        // Flaky rather than failing, so it can't be recorded as broken: see the reason.
        "text replies answer two pending approvals one at a time, in the order shown":
          "a reply sent while approvals wait goes out as a steering message, which sometimes restarts the turn instead of answering",
      },
    },
  ],
} satisfies Record<string, readonly ConformanceChannel[]>;

/**
 * A broken cell fails with its symptom, often a wait that never ends, so it gets
 * a short wait. Real platform calls arrive in well under a second once warm.
 */
const BROKEN_WAIT_TIMEOUT_MS = 3_000;

/** How one channel or client stands on one rule. */
type Cell =
  | { readonly kind: "pass" }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "broken"; readonly broken: BrokenCell };

const CAPABILITY_NAMES: Record<ChannelCapability, string> = {
  attachments: "files a person can send",
  "another-person": "second person who can act",
  buttons: "buttons a person can press",
  "text-replies": "plain-text replies",
};

function variesByConversation(rule: (typeof channelContract)[number]): boolean {
  return (rule as ContractRule).variesByConversation === true;
}

function cellOf(entry: ConformanceChannel, rule: (typeof channelContract)[number]): Cell {
  if (entry.dm === true && !variesByConversation(rule)) {
    return {
      kind: "unsupported",
      reason:
        "it doesn't vary between a shared thread and a DM, and the shared-thread column covers it",
    };
  }
  const { capabilities, surface } = entry.driver();
  const missing = rule.requires.filter((capability) => !capabilities.includes(capability));
  if (missing.length > 0) {
    const names = missing.map((capability) => CAPABILITY_NAMES[capability]).join(" or ");
    return { kind: "unsupported", reason: `the platform has no ${names}` };
  }
  const { surfaces } = rule as ContractRule;
  if (surfaces !== undefined && !surfaces.includes(surface)) {
    return {
      kind: "unsupported",
      reason: `the rule applies only where the conversation is ${surfaces.join(" or ")}, and this one is ${surface}`,
    };
  }
  const declined = entry.unsupported?.[rule.rule];
  if (declined !== undefined) return { kind: "unsupported", reason: declined };
  const broken = entry.broken?.[rule.rule];
  return broken === undefined ? { kind: "pass" } : { kind: "broken", broken };
}

/**
 * Declares the channel contract cells for one channel directory. Each channel gets
 * its own test file because conversations can't overlap within a process, and
 * separate files let vitest run channels in parallel workers.
 */
export function describeChannelConformance(channel: keyof typeof channelConformance): void {
  const entries: readonly ConformanceChannel[] = channelConformance[channel];
  describe.each(entries.map((entry) => ({ entry, name: entry.driver().name })))(
    "$name channel contract",
    ({ entry }) => {
      for (const rule of channelContract) {
        const cell = cellOf(entry, rule);
        const { agent } = rule as ContractRule;
        const run = (options?: { readonly waitTimeoutMs: number }) =>
          withChannelConversation(entry.driver(), (c) => rule.run(c), { ...agent, ...options });
        if (cell.kind === "unsupported") {
          it.skip(`${rule.rule} (not supported: ${cell.reason})`, () => {});
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
export function renderConformanceMatrix(): string {
  const all = Object.values(channelConformance).flatMap(
    (group): readonly ConformanceChannel[] => group,
  );
  const nameOf = (entry: ConformanceChannel) => entry.driver().name;
  const dmOf = (entry: ConformanceChannel) =>
    all.filter((dm) => dm.dm === true && nameOf(dm) === `${nameOf(entry)}-dm`);
  // The TUI and web chat, then Chat SDK's bridges, then channels with a DM column,
  // then the rest. Each DM column sits right after its channel's shared-thread column.
  const group = (entry: ConformanceChannel) => {
    if (nameOf(entry) === "tui") return 0;
    if (nameOf(entry) === "web chat") return 1;
    if (nameOf(entry).startsWith("chat-sdk")) return 2;
    return dmOf(entry).length > 0 ? 3 : 4;
  };
  const entries = all
    .filter((entry) => entry.dm !== true)
    .toSorted((a, b) => group(a) - group(b))
    .flatMap((entry) => [entry, ...dmOf(entry)]);
  const escape = (text: string) => text.replaceAll("|", "\\|");
  const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  // One note per distinct reason, numbered in reading order, so every cell
  // sharing a cause links to the same note. Plain anchors rather than Markdown
  // footnotes, which GitHub renders with links back up to every citing cell.
  const notes = new Map<string, number>();
  const shown = (entry: ConformanceChannel, rule: (typeof channelContract)[number]) => {
    // A DM column leaves blank what only the shared-thread column runs.
    if (entry.dm === true && !variesByConversation(rule)) return "";
    const cell = cellOf(entry, rule);
    if (cell.kind === "pass") return MATRIX_SYMBOLS.pass;
    const note = cell.kind === "broken" ? cell.broken.reason : cell.reason;
    if (!notes.has(note)) notes.set(note, notes.size + 1);
    const index = notes.get(note)!;
    return `${MATRIX_SYMBOLS[cell.kind]}<sup>[${index}](#note-${index})</sup>`;
  };
  // One table per section, each repeating the column header so it reads on its own.
  const tables = channelContractSections.flatMap((section) => [
    `## ${section.title}`,
    "",
    row(["Rule", ...entries.map((entry) => `\`${nameOf(entry)}\``)]),
    row(["---", ...entries.map(() => ":---:")]),
    ...section.rules.map((rule) =>
      row([
        // Non-breaking spaces keep each rule on one line; GitHub scrolls the table instead.
        escape(rule.rule).replaceAll(" ", "\u00a0"),
        ...entries.map((entry) => shown(entry, rule)),
      ]),
    ),
    "",
  ]);
  return [
    "# Channel conformance matrix",
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
    "✅ passes · ❌ broken · — not supported",
    "",
    ...tables,
    "## Notes",
    "",
    ...[...notes].map(([note, index]) => `${index}. <a id="note-${index}"></a>${note}`),
    "",
  ].join("\n");
}
