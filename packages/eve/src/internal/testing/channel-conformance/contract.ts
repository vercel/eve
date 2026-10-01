import { expect } from "vitest";

import {
  type ChannelCapability,
  type ChannelConversation,
  GATED_TOOL,
} from "#internal/testing/channel-conformance/harness.js";

/**
 * One behavior every first-party channel owes a person, stated once and run
 * against every channel whose platform has the capabilities it `requires`.
 */
export interface ContractRule {
  /** The behavior, in one sentence. Also the test name. */
  readonly rule: string;
  /** Where the behavior is promised: a docs anchor or the PR that introduced it. */
  readonly source: string;
  readonly requires: readonly ChannelCapability[];
  run(conversation: ChannelConversation): Promise<void>;
}

const ASK =
  'Use ask_question and set question to: "Which day works for the review?" with label "Saturday" and label "Sunday".';
const PROMPT = "Which day works for the review?";

async function askWhichDay(conversation: ChannelConversation) {
  await conversation.say(ASK);
  return await conversation.waitForQuestion(PROMPT);
}

const DEPLOY = `Use ${GATED_TOOL} to ship the release.`;
const APPROVAL_PROMPT = "Approve Deploy release?";

async function askToDeploy(conversation: ChannelConversation) {
  await conversation.say(DEPLOY);
  return await conversation.waitForQuestion(APPROVAL_PROMPT);
}

async function expectDeployed(conversation: ChannelConversation) {
  const outcome = await conversation.waitForToolOutcome(GATED_TOOL);
  expect(outcome, `${GATED_TOOL} settled as ${JSON.stringify(outcome)}`).toEqual({
    kind: "ran",
    output: { deployed: true },
  });
  expect(conversation.gatedToolRuns).toBe(1);
}

async function expectNotDeployed(conversation: ChannelConversation) {
  const outcome = await conversation.waitForToolOutcome(GATED_TOOL);
  expect(outcome, `${GATED_TOOL} settled as ${JSON.stringify(outcome)}`).toEqual({
    kind: "denied",
  });
  expect(conversation.gatedToolRuns).toBe(0);
}

function expectAnsweredSaturday(output: unknown) {
  // The message carries the real output so a broken cell's symptom can match it.
  expect(output, `ask_question returned ${JSON.stringify(output)}`).toEqual({
    answer: "Saturday",
    status: "answered",
  });
}

type Answer = "press" | "text";

async function answerSaturday(conversation: ChannelConversation, by: Answer) {
  const options = await askWhichDay(conversation);
  if (by === "press") {
    const saturday = options.find((option) => option.label === "Saturday");
    expect(saturday, "a Saturday option to press").toBeDefined();
    await conversation.press(saturday!);
  } else {
    await conversation.say("Saturday");
  }
  expectAnsweredSaturday(await conversation.waitForToolResult("ask_question"));
}

async function approveDeploy(conversation: ChannelConversation, by: Answer) {
  const options = await askToDeploy(conversation);
  if (by === "press") {
    const approve = options.find((option) => option.label === "Approve");
    expect(approve, "an Approve option to press").toBeDefined();
    await conversation.press(approve!);
  } else {
    await conversation.say("approve");
  }
  await expectDeployed(conversation);
}

/** Once answered, the prompt's message stops offering choices nobody can use anymore. */
function expectButtonsCleared(conversation: ChannelConversation, prompt: string) {
  const labels = conversation.shownPrompt(prompt).options.map((option) => option.label);
  expect(labels, `the answered prompt still offers ${JSON.stringify(labels)}`).toEqual([]);
}

/** Once answered, the prompt's message shows everyone in the conversation who answered it. */
function expectResponderNamed(conversation: ChannelConversation, prompt: string) {
  const { text } = conversation.shownPrompt(prompt);
  expect(
    conversation.personShownAs.some((name) => text.includes(name)),
    `the answered prompt never names who answered: ${JSON.stringify(text)}`,
  ).toBe(true);
}

export const hitlContract = [
  {
    rule: "a rendered question shows every option a person can choose",
    source: "docs/tools/human-in-the-loop.md#questions",
    requires: [],
    async run(conversation) {
      const options = await askWhichDay(conversation);
      expect(
        options.map((option) => option.label),
        `the question showed ${JSON.stringify(options.map((option) => option.label))}`,
      ).toEqual(["Saturday", "Sunday"]);
    },
  },
  {
    rule: "pressing a rendered option answers the pending question with that option",
    source: "docs/tools/human-in-the-loop.md#answering-from-a-client-or-channel",
    requires: ["buttons"],
    async run(conversation) {
      const options = await askWhichDay(conversation);
      const saturday = options.find((option) => option.label === "Saturday");
      expect(saturday, "a Saturday option to press").toBeDefined();
      await conversation.press(saturday!);
      expectAnsweredSaturday(await conversation.waitForToolResult("ask_question"));
    },
  },
  {
    rule: "a text reply matching an option answers the only pending question",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["text-replies"],
    async run(conversation) {
      await askWhichDay(conversation);
      await conversation.say("Saturday");
      expectAnsweredSaturday(await conversation.waitForToolResult("ask_question"));
    },
  },
  {
    rule: "a tool approval shows Approve and Cancel",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: [],
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const labels = options.map((option) => option.label).sort();
      expect(labels, `the approval showed ${JSON.stringify(labels)}`).toEqual([
        "Approve",
        "Cancel",
      ]);
    },
  },
  {
    rule: "pressing Approve runs the gated tool",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: ["buttons"],
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const approve = options.find((option) => option.label === "Approve");
      expect(approve, "an Approve option to press").toBeDefined();
      await conversation.press(approve!);
      await expectDeployed(conversation);
    },
  },
  {
    rule: "pressing Cancel stops the gated tool without running it",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: ["buttons"],
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const cancel = options.find((option) => option.label === "Cancel");
      expect(cancel, "a Cancel option to press").toBeDefined();
      await conversation.press(cancel!);
      await expectNotDeployed(conversation);
    },
  },
  {
    rule: "a text reply of approve runs the gated tool",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["text-replies"],
    async run(conversation) {
      await askToDeploy(conversation);
      await conversation.say("approve");
      await expectDeployed(conversation);
    },
  },
  {
    rule: "a text reply of cancel stops the gated tool without running it",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["text-replies"],
    async run(conversation) {
      await askToDeploy(conversation);
      await conversation.say("cancel");
      await expectNotDeployed(conversation);
    },
  },
  {
    rule: "pressing an option clears the question's buttons",
    source: "#1 (Slack's answered question card)",
    requires: ["buttons"],
    async run(conversation) {
      await answerSaturday(conversation, "press");
      expectButtonsCleared(conversation, PROMPT);
    },
  },
  {
    rule: "answering a question by text clears its buttons",
    source: "#1 (Slack's answered question card)",
    requires: ["buttons", "text-replies"],
    async run(conversation) {
      await answerSaturday(conversation, "text");
      expectButtonsCleared(conversation, PROMPT);
    },
  },
  {
    rule: "pressing an option names who answered on the question",
    source: "#1 (Slack's answered question card)",
    requires: ["buttons"],
    async run(conversation) {
      await answerSaturday(conversation, "press");
      expectResponderNamed(conversation, PROMPT);
    },
  },
  {
    rule: "answering a question by text names who answered on the question",
    source: "#1 (Slack's answered question card)",
    requires: ["buttons", "text-replies"],
    async run(conversation) {
      await answerSaturday(conversation, "text");
      expectResponderNamed(conversation, PROMPT);
    },
  },
  {
    rule: "pressing Approve clears the approval's buttons",
    source: "#2212 (Slack's settled approval card)",
    requires: ["buttons"],
    async run(conversation) {
      await approveDeploy(conversation, "press");
      expectButtonsCleared(conversation, APPROVAL_PROMPT);
    },
  },
  {
    rule: "approving by text clears the approval's buttons",
    source: "#2212 (Slack's settled approval card)",
    requires: ["buttons", "text-replies"],
    async run(conversation) {
      await approveDeploy(conversation, "text");
      expectButtonsCleared(conversation, APPROVAL_PROMPT);
    },
  },
  {
    rule: "pressing Approve names who approved on the approval",
    source: "#2212 (Slack's settled approval card)",
    requires: ["buttons"],
    async run(conversation) {
      await approveDeploy(conversation, "press");
      expectResponderNamed(conversation, APPROVAL_PROMPT);
    },
  },
  {
    rule: "approving by text names who approved on the approval",
    source: "#2212 (Slack's settled approval card)",
    requires: ["buttons", "text-replies"],
    async run(conversation) {
      await approveDeploy(conversation, "text");
      expectResponderNamed(conversation, APPROVAL_PROMPT);
    },
  },
] as const satisfies readonly ContractRule[];

export type HitlRule = (typeof hitlContract)[number]["rule"];
