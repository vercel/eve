import { afterAll, describe, expect, it } from "vitest";

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
import { boardDriver } from "#internal/testing/channel-conformance/board-driver.js";
import type { ConformanceHostKind } from "#internal/testing/channel-conformance/hosts.js";
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
  readonly symptom: RegExp;
}

export interface ConformanceChannel {
  readonly driver: () => ChannelDriver | ClientDriver;
  readonly dm?: true;
  readonly broken?: Partial<Record<ContractRuleName, BrokenCell>>;
  readonly unsupported?: Partial<Record<ContractRuleName, string>>;
}

const SIGN_IN_NOT_SHOWN = /Timed out waiting for the bot to show/u;

function signInKeptPrivate(
  reason: string,
  ...rules: ContractRuleName[]
): Partial<Record<ContractRuleName, string>> {
  return Object.fromEntries(rules.map((rule) => [rule, reason]));
}

const SIGN_IN_SHOWN_RULES = [
  "a sign-in names the service and shows its sign-in link",
  "a sign-in shows its confirmation code",
  "a sign-in without a link shows its instructions",
] as const satisfies readonly ContractRuleName[];

const LINQ_SIGN_IN_NOT_PRIVATE = Object.fromEntries(
  [
    "a sign-in names the service and shows its sign-in link",
    "a sign-in shows its confirmation code",
    "a sign-in without a link shows its instructions",
    "completing a sign-in stops showing its link and code",
  ].map((rule) => [
    rule,
    {
      reason:
        "Linq's openDM needs the person's phone handle, but a message names its sender by an opaque handle id, so the bot can only say to continue in a direct message",
      symptom: SIGN_IN_NOT_SHOWN,
    },
  ]),
) satisfies Partial<Record<ContractRuleName, BrokenCell>>;

const SIGN_IN_COMPLETED_RULE = "completing a sign-in stops showing its link and code";

function signInLingers(reason: string): Partial<Record<ContractRuleName, BrokenCell>> {
  return {
    [SIGN_IN_COMPLETED_RULE]: {
      reason,
      symptom: /the sign-in prompt is still shown after signing in/u,
    },
  };
}

const SIGN_IN_LINGERS = signInLingers(
  "the challenge message stays as it was sent after the sign-in completes",
);

const SLACK_SIGN_IN_LINGERS = signInLingers(
  "the private prompt is ephemeral, and nothing deletes it when the sign-in completes; only a press's response_url can",
);

const CHAT_SDK_BROKEN = {
  "a question pressed after the session's run ended outside eve keeps its prompt and says it is no longer active":
    {
      reason:
        "a press carries only the card's message id, and the session that knew its prompt is gone, so the retired card shows only how it ended",
      symptom: /the inactive prompt reads .* to contain/u,
    },
} satisfies Partial<Record<ContractRuleName, BrokenCell>>;

const SIGN_IN_PRESS_RULE = "someone else pressing a sign-in isn't shown its link or code";
const SIGN_IN_SENT_PRIVATELY = {
  [SIGN_IN_PRESS_RULE]:
    "the sign-in goes privately to the person signing in, so the thread shows nothing to press",
} satisfies Partial<Record<ContractRuleName, string>>;

const DISCORD_UNSUPPORTED = {
  "a file sent earlier in the conversation is still there on a later message":
    "each slash command starts its own session, so no later message shares one with the file",
} satisfies Partial<Record<ContractRuleName, string>>;

const DISCORD_SERVER_SIGN_IN = signInKeptPrivate(
  "a server channel gets a link-free status whose button reveals the challenge to its person alone; the driver does not press it to show the initial challenge",
  ...SIGN_IN_SHOWN_RULES,
);

const SLACK_BROKEN = {
  "text replies answer two pending approvals one at a time, in the order shown": {
    reason:
      "one card shows every approval a step raises, so a typed reply can't say which it answers",
    symptom: /were shown in one message, so a typed reply can't say which it answers/,
  },
} satisfies Partial<Record<ContractRuleName, BrokenCell>>;

const TUI_TYPED_APPROVAL =
  "the approval drawer holds the keyboard; a person answers it with y or n";
const TUI_TYPED_REPLIES =
  "each open request has its own drawer, and typing a message dismisses them all";
const TUI_SINGLE_PERSON = "one person answers at their own terminal; there's nobody else to tell";
const WEB_CHAT_SINGLE_PERSON =
  "one person answers in their own browser tab; there's nobody else to tell";

const channelConformance = {
  "chat-sdk": [
    {
      driver: chatSdkDriver,
      broken: { ...CHAT_SDK_BROKEN, ...SIGN_IN_LINGERS },
      unsupported: SIGN_IN_SENT_PRIVATELY,
    },
    { driver: chatSdkTextDriver },
  ],
  "chat-sdk-dm": [{ dm: true, driver: () => chatSdkDriver("private") }],
  discord: [
    {
      driver: () => discordDriver(),
      broken: SIGN_IN_LINGERS,
      unsupported: { ...DISCORD_UNSUPPORTED, ...DISCORD_SERVER_SIGN_IN },
    },
    {
      driver: () => discordDriver("shared", "gateway"),
      broken: SIGN_IN_LINGERS,
      unsupported: DISCORD_SERVER_SIGN_IN,
    },
    {
      driver: () => discordDriver("shared", "gateway-threads"),
      broken: SIGN_IN_LINGERS,
      unsupported: DISCORD_SERVER_SIGN_IN,
    },
  ],
  "discord-dm": [
    {
      dm: true,
      driver: () => discordDriver("private"),
      unsupported: DISCORD_UNSUPPORTED,
    },
    {
      dm: true,
      driver: () => discordDriver("private", "gateway"),
    },
  ],
  board: [
    {
      driver: boardDriver,
      unsupported: signInKeptPrivate(
        "a shared board thread gets a status saying where to connect, since nothing on a board is private to one person",
        ...SIGN_IN_SHOWN_RULES,
        SIGN_IN_COMPLETED_RULE,
      ),
    },
  ],
  github: [
    {
      driver: githubDriver,
      unsupported: signInKeptPrivate(
        "a public thread gets a status naming who must sign in, since nothing on GitHub is private to them",
        "a sign-in without a link shows its instructions",
      ),
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
        ...SIGN_IN_LINGERS,
      },
    },
  ],
  linq: [{ driver: linqDriver, broken: LINQ_SIGN_IN_NOT_PRIVATE }],
  "linq-dm": [{ dm: true, driver: () => linqDriver("private") }],
  photon: [{ driver: photonDriver }],
  slack: [
    {
      driver: slackDriver,
      broken: { ...SLACK_BROKEN, ...SLACK_SIGN_IN_LINGERS },
      unsupported: SIGN_IN_SENT_PRIVATELY,
    },
  ],
  "slack-dm": [
    {
      dm: true,
      driver: () => slackDriver("private"),
      broken: { ...SLACK_BROKEN, ...SLACK_SIGN_IN_LINGERS },
    },
  ],
  "slack-code-channel": [
    {
      driver: () => slackDriver("code-channel"),
      broken: { ...SLACK_BROKEN, ...SLACK_SIGN_IN_LINGERS },
      unsupported: SIGN_IN_SENT_PRIVATELY,
    },
  ],
  teams: [
    {
      driver: teamsDriver,
      broken: SIGN_IN_LINGERS,
      unsupported: signInKeptPrivate(
        "a group gets a link-free card whose button reveals the challenge to its person alone; the driver does not press it to show the initial challenge",
        ...SIGN_IN_SHOWN_RULES,
      ),
    },
  ],
  "teams-dm": [{ dm: true, driver: () => teamsDriver("private") }],
  telegram: [
    {
      driver: telegramDriver,
      broken: SIGN_IN_LINGERS,
      unsupported: signInKeptPrivate(
        "a group's status sends the challenge privately once the person presses Authorize, which the driver doesn't press",
        ...SIGN_IN_SHOWN_RULES,
        "only the person signing in sees the sign-in link and code",
      ),
    },
  ],
  "telegram-dm": [{ dm: true, driver: () => telegramDriver("private") }],
  tui: [
    {
      driver: tuiDriver,
      unsupported: {
        "pressing an option of an answered question sends it to the agent as new input":
          "an answered question's drawer closes, so nothing is left to press",
        "a text reply of approve runs the gated tool": TUI_TYPED_APPROVAL,
        "a text reply of deny stops the gated tool without running it": TUI_TYPED_APPROVAL,
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
  twilio: [
    {
      driver: twilioDriver,
      unsupported: { [SIGN_IN_COMPLETED_RULE]: "a sent SMS can't be edited or taken back" },
    },
  ],
  "web-chat": [
    {
      driver: webChatDriver,
      unsupported: {
        "a file that can't be downloaded reaches the agent as a note, not a link, and the next message still works":
          "the browser sends a file's bytes with the message, so there is no download to fail",
        "pressing an option of an answered question sends it to the agent as new input":
          "an answered question disables its options, so nothing is left to press",
        "pressing Approve names who approved on the approval": WEB_CHAT_SINGLE_PERSON,
        "approving by text names who approved on the approval": WEB_CHAT_SINGLE_PERSON,
        "pressing an option names who answered on the question": WEB_CHAT_SINGLE_PERSON,
        "answering a question by text names who answered on the question": WEB_CHAT_SINGLE_PERSON,
        "text replies answer two pending approvals one at a time, in the order shown":
          "a reply sent while approvals wait goes out as a steering message, which sometimes restarts the turn instead of answering",
      },
    },
  ],
} satisfies Record<string, readonly ConformanceChannel[]>;

const BROKEN_WAIT_TIMEOUT_MS = 3_000;

type Cell =
  | { readonly kind: "pass" }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "broken"; readonly broken: BrokenCell };

const CAPABILITY_NAMES: Record<ChannelCapability, string> = {
  attachments: "files a person can send",
  "another-person": "second person who can act",
  buttons: "buttons a person can press",
  "sign-in-cancel": "Cancel on its sign-in prompt",
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

function inProcessGap(rule: string): string | undefined {
  if (rule.includes("run ended"))
    return "it cancels the session's Workflow run, which an in-process session doesn't have";
  return undefined;
}

const WORKFLOW_CHANNEL = "web-chat";

function runsOn(host: ConformanceHostKind, channel: string | undefined, rule: string): boolean {
  if (host === "in-process") return true;
  return channel === WORKFLOW_CHANNEL || inProcessGap(rule) !== undefined;
}

const HOSTS: readonly ConformanceHostKind[] = ["in-process", "workflow"];

export function describeChannelConformance(channel: keyof typeof channelConformance): void {
  describeConformance(channelConformance[channel], channel);
}

export function describeConformance(
  entries: readonly ConformanceChannel[],
  channel?: string,
): void {
  afterAll(async () => {
    for (const entry of entries) await entry.driver().dispose?.();
  });
  const cases = entries.flatMap((entry) =>
    HOSTS.map((host) => ({ entry, host, name: entry.driver().name })),
  );
  describe.each(cases)("$name channel contract ($host)", ({ entry, host }) => {
    for (const rule of channelContract) {
      if (!runsOn(host, channel, rule.rule)) continue;
      const gap = host === "in-process" ? inProcessGap(rule.rule) : undefined;
      const cell: Cell =
        gap === undefined ? cellOf(entry, rule) : { kind: "unsupported", reason: gap };
      const { agent } = rule as ContractRule;
      const run = (options?: { readonly waitTimeoutMs: number }) =>
        withChannelConversation(entry.driver(), (c) => rule.run(c), {
          ...agent,
          ...options,
          host,
        });
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
  });
}

const MATRIX_SYMBOLS = { broken: "❌", pass: "✅", unsupported: "—" } as const;

export function renderConformanceMatrix(): string {
  const all = Object.values(channelConformance).flatMap(
    (group): readonly ConformanceChannel[] => group,
  );
  const nameOf = (entry: ConformanceChannel) => entry.driver().name;
  const dmOf = (entry: ConformanceChannel) =>
    all.filter((dm) => dm.dm === true && nameOf(dm) === `${nameOf(entry)}-dm`);
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
  const notes = new Map<string, number>();
  const shown = (entry: ConformanceChannel, rule: (typeof channelContract)[number]) => {
    if (entry.dm === true && !variesByConversation(rule)) return "";
    const cell = cellOf(entry, rule);
    if (cell.kind === "pass") return MATRIX_SYMBOLS.pass;
    const note = cell.kind === "broken" ? cell.broken.reason : cell.reason;
    if (!notes.has(note)) notes.set(note, notes.size + 1);
    const index = notes.get(note)!;
    return `${MATRIX_SYMBOLS[cell.kind]}<sup>[${index}](#note-${index})</sup>`;
  };
  const tables = channelContractSections.flatMap((section) => [
    `## ${section.title}`,
    "",
    row(["Rule", ...entries.map((entry) => `\`${nameOf(entry)}\``)]),
    row(["---", ...entries.map(() => ":---:")]),
    ...section.rules.map((rule) =>
      row([
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
