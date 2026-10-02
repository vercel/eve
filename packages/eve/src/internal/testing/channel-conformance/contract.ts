import { expect } from "vitest";

import {
  type ChannelCapability,
  type ChannelConversation,
  GATED_TOOL,
  type RenderedOption,
  SECOND_GATED_TOOL,
  TWO_QUESTIONS_TOOL,
} from "#internal/testing/channel-conformance/harness.js";
import {
  DAY_PROMPT,
  TIME_PROMPT,
} from "#internal/testing/channel-conformance/two-questions-workflow.js";

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
const PROMPT = DAY_PROMPT;

async function askWhichDay(conversation: ChannelConversation) {
  await conversation.say(ASK);
  return await conversation.waitForQuestion(PROMPT);
}

const OPEN_PROMPT = "What should the review cover?";
const ASK_OPEN = `Use ask_question and set question to: "${OPEN_PROMPT}"`;
const OWN_WORDS = "Mostly the billing migration";

const PLAN_REVIEW = `Use ${TWO_QUESTIONS_TOOL} to plan the review.`;

const DEPLOY = `Use ${GATED_TOOL} to ship the release.`;
// Channels word the two approval choices differently; the TUI asks Yes or No.
const APPROVE_LABELS = ["Approve", "Yes"];
const CANCEL_LABELS = ["Cancel", "No"];
const APPROVAL_PROMPT = "Approve Deploy release?";

async function askToDeploy(conversation: ChannelConversation) {
  await conversation.say(DEPLOY);
  return await conversation.waitForQuestion(APPROVAL_PROMPT);
}

const PUBLISH_PROMPT = "Approve Publish notes?";

const DEPLOY_AND_PUBLISH = `Call tools in parallel: ${GATED_TOOL}, ${SECOND_GATED_TOOL}`;
const ASK_AND_DEPLOY = `Call tools in parallel: ask_question, ${GATED_TOOL}\n${ASK}`;

/** Answers each prompt with its option, in whatever order the client shows them. */
function answerEach(
  conversation: ChannelConversation,
  choices: Record<string, string | readonly string[]>,
): Promise<void> {
  return conversation.answerEach(Object.keys(choices), (prompt, options) =>
    option(options, choices[prompt]!),
  );
}

/** The option a person would press for `label`, or any of its channel-specific wordings. */
function option(
  options: readonly RenderedOption[] | undefined,
  label: string | readonly string[],
): RenderedOption {
  const labels = typeof label === "string" ? [label] : label;
  const found = options?.find((candidate) => labels.includes(candidate.label));
  expect(found, `a ${labels.join(" or ")} option to press`).toBeDefined();
  return found!;
}

async function expectDeployed(conversation: ChannelConversation) {
  const outcome = await conversation.waitForToolOutcome(GATED_TOOL);
  expect(outcome, `${GATED_TOOL} settled as ${JSON.stringify(outcome)}`).toEqual({
    kind: "ran",
    output: { deployed: true },
  });
  expect(conversation.runsOf(GATED_TOOL)).toBe(1);
}

async function expectNotDeployed(conversation: ChannelConversation) {
  const outcome = await conversation.waitForToolOutcome(GATED_TOOL);
  expect(outcome, `${GATED_TOOL} settled as ${JSON.stringify(outcome)}`).toEqual({
    kind: "denied",
  });
  expect(conversation.runsOf(GATED_TOOL)).toBe(0);
}

function expectAnswered(output: unknown, answer: string) {
  // The message carries the real output so a broken cell's symptom can match it.
  expect(output, `ask_question returned ${JSON.stringify(output)}`).toEqual({
    answer,
    status: "answered",
  });
}

function expectAnsweredSaturday(output: unknown) {
  expectAnswered(output, "Saturday");
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
    const approve = options.find((option) => APPROVE_LABELS.includes(option.label));
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
    rule: "a text reply that matches no option answers the question with the person's words",
    source: "docs/tools/human-in-the-loop.md#questions",
    requires: ["text-replies"],
    async run(conversation) {
      await askWhichDay(conversation);
      await conversation.say(OWN_WORDS);
      expectAnswered(await conversation.waitForToolResult("ask_question"), OWN_WORDS);
    },
  },
  {
    rule: "a text reply answers an open-ended question with the person's words",
    source: "docs/tools/human-in-the-loop.md#questions",
    requires: ["text-replies"],
    async run(conversation) {
      await conversation.say(ASK_OPEN);
      await conversation.waitForQuestion(OPEN_PROMPT);
      await conversation.say(OWN_WORDS);
      expectAnswered(await conversation.waitForToolResult("ask_question"), OWN_WORDS);
    },
  },
  {
    rule: "pressing an option of an answered question sends it to the agent as new input",
    source: "docs/tools/workflows.mdx#ask-a-human-ctxask",
    requires: ["buttons"],
    async run(conversation) {
      const options = await askWhichDay(conversation);
      const saturday = options.find((option) => option.label === "Saturday");
      expect(saturday, "a Saturday option to press").toBeDefined();
      await conversation.press(saturday!);
      expectAnsweredSaturday(await conversation.waitForToolResult("ask_question"));
      await conversation.press(saturday!);
      await conversation.waitForReplyTo("Saturday");
    },
  },
  {
    rule: "pressing options of two pending questions answers each with its own option",
    source: "docs/tools/workflows.mdx#ask-a-human-ctxask",
    requires: ["buttons"],
    async run(conversation) {
      await conversation.say(PLAN_REVIEW);
      await answerEach(conversation, { [DAY_PROMPT]: "Saturday", [TIME_PROMPT]: "Afternoon" });
      const output = await conversation.waitForToolResult(TWO_QUESTIONS_TOOL);
      expect(output, `${TWO_QUESTIONS_TOOL} returned ${JSON.stringify(output)}`).toEqual({
        day: "Saturday",
        time: "Afternoon",
      });
    },
  },
  {
    rule: "a text reply matching an option does not answer either of two pending questions",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["text-replies"],
    async run(conversation) {
      await conversation.say(PLAN_REVIEW);
      await conversation.waitForRequest(DAY_PROMPT);
      await conversation.waitForRequest(TIME_PROMPT);
      await conversation.say("Saturday");
      // Answering only the day question would leave the tool waiting, with no reply.
      await conversation.waitForReplyTo("Saturday");
    },
  },
  {
    rule: "a tool approval shows a choice to approve and one to cancel",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: [],
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const labels = options.map((option) => option.label);
      const message = `the approval showed ${JSON.stringify(labels)}`;
      expect(labels, message).toHaveLength(2);
      expect(
        labels.filter((label) => APPROVE_LABELS.includes(label)),
        message,
      ).toHaveLength(1);
      expect(
        labels.filter((label) => CANCEL_LABELS.includes(label)),
        message,
      ).toHaveLength(1);
    },
  },
  {
    rule: "pressing Approve runs the gated tool",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: ["buttons"],
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const approve = options.find((option) => APPROVE_LABELS.includes(option.label));
      expect(approve, "an Approve option to press").toBeDefined();
      await conversation.press(approve!);
      await expectDeployed(conversation);
    },
  },
  {
    rule: "pressing Approve twice runs the gated tool once",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: ["buttons"],
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const approve = option(options, APPROVE_LABELS);
      await conversation.press(approve);
      await conversation.press(approve);
      await expectDeployed(conversation);
      // However the channel reads the second press, the session must finish with it.
      await conversation.waitForRest();
      expect(conversation.runsOf(GATED_TOOL)).toBe(1);
    },
  },
  {
    rule: "pressing Approve on one of two pending approvals runs only that tool",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: ["buttons"],
    async run(conversation) {
      await conversation.say(DEPLOY_AND_PUBLISH);
      await answerEach(conversation, {
        [APPROVAL_PROMPT]: APPROVE_LABELS,
        [PUBLISH_PROMPT]: CANCEL_LABELS,
      });
      // Results reach the model in the order they settle, so the reply names the approved call.
      await expectDeployed(conversation);
      expect(conversation.runsOf(SECOND_GATED_TOOL)).toBe(0);
    },
  },
  {
    rule: "answering an approval and a question pending together settles both",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["buttons"],
    async run(conversation) {
      await conversation.say(ASK_AND_DEPLOY);
      await answerEach(conversation, { [APPROVAL_PROMPT]: APPROVE_LABELS, [PROMPT]: "Saturday" });
      // The turn replies only once both calls settle.
      await expectDeployed(conversation);
    },
  },
  {
    rule: "pressing Cancel stops the gated tool without running it",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: ["buttons"],
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const cancel = options.find((option) => CANCEL_LABELS.includes(option.label));
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
