import { createHash } from "node:crypto";

import { expect } from "vitest";

import {
  type ChannelCapability,
  type ChannelConversation,
  type ConversationOptions,
  deployPrompt,
  GATED_TOOL,
  type GatedTool,
  OPEN_GATED_TOOL,
  type Person,
  PLAIN_TOOL,
  type RenderedOption,
  REQUESTER_GATED_TOOL,
  RETRO_DAY_TOOL,
  type SentFile,
  type Surface,
  SECOND_GATED_TOOL,
  SIGN_IN_TOOLS,
  TWO_QUESTIONS_TOOL,
} from "#internal/testing/channel-conformance/harness.js";
import {
  DAY_PROMPT,
  RETRO_PROMPT,
  TIME_PROMPT,
} from "#internal/testing/channel-conformance/question-workflows.js";

export interface ContractRule {
  readonly rule: string;
  readonly source: string;
  readonly requires: readonly ChannelCapability[];
  readonly variesByConversation?: boolean;
  readonly surfaces?: readonly Surface[];
  readonly agent?: Pick<ConversationOptions, "limits">;
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

const RELEASE = 'release "v2.4"';
const DEPLOY = `Use ${GATED_TOOL} to ship ${RELEASE}.`;
const APPROVE_LABELS = ["Approve", "Yes"];
const DENY_LABELS = ["Deny", "No"];
const APPROVAL_PROMPT = deployPrompt("v2.4");

async function askToDeploy(conversation: ChannelConversation) {
  await conversation.say(DEPLOY);
  return await conversation.waitForQuestion(APPROVAL_PROMPT);
}

const PUBLISH_PROMPT = "Approve Publish notes?";

const DEPLOY_AND_PUBLISH = `Call tools in parallel: ${GATED_TOOL}, ${SECOND_GATED_TOOL}\nShip ${RELEASE}.`;
const ASK_AND_DEPLOY = `Call tools in parallel: ask_question, ${GATED_TOOL}\n${ASK}\nShip ${RELEASE}.`;

function answerEach(
  conversation: ChannelConversation,
  choices: Record<string, string | readonly string[]>,
): Promise<void> {
  return conversation.answerEach(Object.keys(choices), (prompt, options) =>
    option(options, choices[prompt]!),
  );
}

function option(
  options: readonly RenderedOption[] | undefined,
  label: string | readonly string[],
): RenderedOption {
  const labels = typeof label === "string" ? [label] : label;
  const found = options?.find((candidate) => labels.includes(candidate.label));
  expect(found, `a ${labels.join(" or ")} option to press`).toBeDefined();
  return found!;
}

const ASIDE = "Alice also wants the changelog summarized.";
const FOLLOW_UP = "Alice asks what is still left to do.";

async function lookUpNotesAs(
  conversation: ChannelConversation,
  people: readonly Person[],
): Promise<readonly (string | null)[]> {
  for (const [index, person] of people.entries()) {
    const request = `request ${index + 1}`;
    await conversation.say(`Use ${PLAIN_TOOL} to find the review notes, ${request}.`, person);
    await conversation.waitForShown(new RegExp(`Used ${PLAIN_TOOL} for .*${request}`, "su"));
  }
  expect(conversation.runsOf(PLAIN_TOOL), `${PLAIN_TOOL} runs`).toBe(people.length);
  return conversation.callersOf(PLAIN_TOOL);
}

const HOTFIX = `Use ${REQUESTER_GATED_TOOL} to ship the fix.`;
const HOTFIX_PROMPT = "Approve Release hotfix?";

async function askToReleaseHotfix(conversation: ChannelConversation) {
  await conversation.say(HOTFIX);
  return await conversation.waitForQuestion(HOTFIX_PROMPT);
}

const ROLL_BACK = `Use ${OPEN_GATED_TOOL} to undo the release.`;
const ROLL_BACK_PROMPT = "Approve Roll back release?";

async function askToRollBack(conversation: ChannelConversation) {
  await conversation.say(ROLL_BACK);
  return await conversation.waitForQuestion(ROLL_BACK_PROMPT);
}

async function expectRan(conversation: ChannelConversation, tool: GatedTool, output: unknown) {
  const outcome = await conversation.waitForToolOutcome(tool);
  expect(outcome, `${tool} settled as ${JSON.stringify(outcome)}`).toEqual({
    kind: "ran",
    output,
  });
  expect(conversation.runsOf(tool)).toBe(1);
}

async function expectDeployed(conversation: ChannelConversation) {
  await expectRan(conversation, GATED_TOOL, { deployed: true });
}

async function expectReleased(conversation: ChannelConversation) {
  await expectRan(conversation, REQUESTER_GATED_TOOL, { released: true });
}

async function expectStillPending(conversation: ChannelConversation) {
  await conversation.waitForRest();
  expect(
    conversation.runsOf(REQUESTER_GATED_TOOL),
    `${REQUESTER_GATED_TOOL} ran on Bob's answer`,
  ).toBe(0);
}

async function expectNotDeployed(conversation: ChannelConversation) {
  const outcome = await conversation.waitForToolOutcome(GATED_TOOL);
  expect(outcome, `${GATED_TOOL} settled as ${JSON.stringify(outcome)}`).toEqual({
    kind: "denied",
  });
  expect(conversation.runsOf(GATED_TOOL)).toBe(0);
}

function expectAnswered(output: unknown, answer: string) {
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

async function expectButtonsCleared(conversation: ChannelConversation, prompt: string) {
  const labels = (await conversation.shownPrompt(prompt)).options.map((option) => option.label);
  expect(labels, `the answered prompt still offers ${JSON.stringify(labels)}`).toEqual([]);
}

async function expectButtonsKept(conversation: ChannelConversation, prompt: string) {
  const labels = (await conversation.shownPrompt(prompt)).options.map((option) => option.label);
  const message = `the rejected prompt offers ${JSON.stringify(labels)}`;
  expect(
    labels.some((label) => APPROVE_LABELS.includes(label)),
    message,
  ).toBe(true);
  expect(
    labels.some((label) => DENY_LABELS.includes(label)),
    message,
  ).toBe(true);
}

async function expectResponderNamed(conversation: ChannelConversation, prompt: string) {
  const { text } = await conversation.shownPrompt(prompt);
  expect(
    conversation.personShownAs.some((name) => text.includes(name)),
    `the answered prompt never names who answered: ${JSON.stringify(text)}`,
  ).toBe(true);
}

const DIAGRAM: SentFile = {
  bytes: Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=",
    "base64",
  ),
  mediaType: "image/jpeg",
  name: "diagram.jpg",
};
const REPORT: SentFile = {
  bytes: Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  ),
  mediaType: "application/pdf",
  name: "report.pdf",
};
const LIST_ATTACHMENTS = "Alice asks to list the attachments.";
const ATTACHMENTS_REPLY = /Attachments: (\[.*?\])(?:\s|$)/su;

interface SeenFile {
  readonly bytes?: number;
  readonly mediaType?: string;
  readonly note?: string;
  readonly sha256?: string;
  readonly url?: string;
}

async function attachmentsSeen(
  conversation: ChannelConversation,
  files?: readonly SentFile[],
): Promise<readonly SeenFile[]> {
  await conversation.say(LIST_ATTACHMENTS, "alice", files);
  const shown = await conversation.waitForShown(ATTACHMENTS_REPLY);
  return JSON.parse(ATTACHMENTS_REPLY.exec(shown)![1]!) as SeenFile[];
}

function asSeen(file: SentFile): SeenFile {
  return {
    bytes: file.bytes.length,
    mediaType: file.mediaType,
    sha256: createHash("sha256").update(file.bytes).digest("hex").slice(0, 16),
  };
}

async function expectFileReachesAgent(conversation: ChannelConversation, file: SentFile) {
  const seen = await attachmentsSeen(conversation, [file]);
  expect(
    seen.map(({ bytes, mediaType, sha256, url }) => ({ bytes, mediaType, sha256, url })),
    `the agent saw ${JSON.stringify(seen)}`,
  ).toEqual([{ ...asSeen(file), url: undefined }]);
}

const ONE_TOKEN_BUDGET = {
  limits: { sessionUsage: ({ window }) => window.inputTokens >= 1 },
} as const satisfies Pick<ConversationOptions, "limits">;
const BUDGET_PROMPT =
  "This session has hit its usage limit. This is a guardrail against defective " +
  "long-running sessions. If session activity looks fine, just approve to keep going.";
const LOOK_UP_NOTES = `Use ${PLAIN_TOOL} to find Bob's review notes.`;
const LATER_MESSAGE = "Carol wants the review by Friday.";

async function exhaustBudget(conversation: ChannelConversation) {
  await conversation.say(LOOK_UP_NOTES);
  return await conversation.waitForQuestion(BUDGET_PROMPT);
}

async function expectWorkContinued(conversation: ChannelConversation) {
  await conversation.waitForReply();
  await conversation.waitForRest();
  expect(conversation.runsOf(PLAIN_TOOL), `${PLAIN_TOOL} ran again after approval`).toBe(1);
}

async function expectStoppedAndAskedAgain(conversation: ChannelConversation) {
  await conversation.say(LATER_MESSAGE);
  const options = await conversation.waitForQuestion(BUDGET_PROMPT);
  expect(options.map((option) => option.label).sort()).toEqual(["Approve", "Stop"]);
  expect(await conversation.replyCount(), "the bot replied after Stop").toBe(0);
}

const CALENDAR = SIGN_IN_TOOLS.read_calendar;
const READ_CALENDAR = "Use read_calendar to check my week.";
const MAIL = SIGN_IN_TOOLS.read_mail;
const READ_MAIL = "Use read_mail to check my inbox.";
const CHANGE_OF_PLANS = "Alice decided to check her week later.";

async function expectSignInToolResult(conversation: ChannelConversation) {
  const output = await conversation.waitForToolResult("read_calendar");
  expect(output, `read_calendar returned ${JSON.stringify(output)}`).toEqual({ signedIn: true });
  expect(conversation.runsOf("read_calendar")).toBe(1);
}

async function requestSignIn(conversation: ChannelConversation, message: string) {
  await conversation.say(message);
  await conversation.waitForSignIn();
  const open = (await conversation.shownOptions()).find((option) =>
    SIGN_IN_OPENERS.test(option.label),
  );
  if (open !== undefined) await conversation.press(open);
}

const SIGN_IN_OPENERS = /^(?:authori[sz]e|sign in)$/iu;

async function expectSignInPromptGone(conversation: ChannelConversation, after: string) {
  const left = (await conversation.visible()).filter(
    ({ options, text }) =>
      text.includes(CALENDAR.url) ||
      text.includes(CALENDAR.userCode) ||
      options.some((option) => option.label === SIGN_IN_CANCEL_LABEL),
  );
  expect(
    left.map(({ text }) => text),
    `the sign-in prompt is still shown ${after}`,
  ).toEqual([]);
}

const SIGN_IN_CANCEL_LABEL = "Cancel";

async function pressSignInCancel(conversation: ChannelConversation) {
  const cancel = (await conversation.visible())
    .flatMap(({ options }) => options)
    .find((option) => option.label === SIGN_IN_CANCEL_LABEL);
  expect(cancel, "a Cancel on the sign-in prompt to press").toBeDefined();
  await conversation.press(cancel!);
}

async function abandonSignIn(conversation: ChannelConversation) {
  await conversation.say(READ_CALENDAR);
  await conversation.waitForSignIn();
  await conversation.waitForRest();
  await conversation.say(CHANGE_OF_PLANS);
}

const questionRules = [
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
    variesByConversation: true,
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
    variesByConversation: true,
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
    variesByConversation: true,
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
    variesByConversation: true,
    async run(conversation) {
      await conversation.say(ASK_OPEN);
      await conversation.waitForQuestion(OPEN_PROMPT);
      await conversation.say(OWN_WORDS);
      expectAnswered(await conversation.waitForToolResult("ask_question"), OWN_WORDS);
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
    rule: "text replies answer two pending questions one at a time, in the order shown",
    source: "docs/tools/human-in-the-loop.md#several-requests-at-once",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await conversation.say(PLAN_REVIEW);
      await conversation.replyToEach({ [DAY_PROMPT]: "Saturday", [TIME_PROMPT]: "Afternoon" });
      const output = await conversation.waitForToolResult(TWO_QUESTIONS_TOOL);
      expect(output, `${TWO_QUESTIONS_TOOL} returned ${JSON.stringify(output)}`).toEqual({
        day: "Saturday",
        time: "Afternoon",
      });
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
    rule: "a message while a question without free text is pending withdraws it, and the next message gets a reply",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await conversation.say(`Use ${RETRO_DAY_TOOL} to schedule the retro.`);
      await conversation.waitForQuestion(RETRO_PROMPT);
      await conversation.say(ASIDE);
      await conversation.waitForReplyTo(ASIDE);
      await conversation.say("Thursday");
      await conversation.waitForRest();
      expect(
        await conversation.sharedText(),
        `${RETRO_DAY_TOOL} took "Thursday" as an answer after the aside`,
      ).not.toMatch(/"day":"Thursday"/u);
      await conversation.waitForReplyTo("Thursday");
    },
  },
] as const satisfies readonly ContractRule[];

const approvalRules = [
  {
    rule: "a tool approval shows the tool's prompt with a choice to approve and one to deny",
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
        labels.filter((label) => DENY_LABELS.includes(label)),
        message,
      ).toHaveLength(1);
    },
  },
  {
    rule: "pressing Approve runs the gated tool",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: ["buttons"],
    variesByConversation: true,
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const approve = options.find((option) => APPROVE_LABELS.includes(option.label));
      expect(approve, "an Approve option to press").toBeDefined();
      await conversation.press(approve!);
      await expectDeployed(conversation);
    },
  },
  {
    rule: "pressing Deny stops the gated tool without running it",
    source: "docs/tools/human-in-the-loop.md#approvals",
    requires: ["buttons"],
    async run(conversation) {
      const options = await askToDeploy(conversation);
      const deny = options.find((option) => DENY_LABELS.includes(option.label));
      expect(deny, "a Deny option to press").toBeDefined();
      await conversation.press(deny!);
      await expectNotDeployed(conversation);
    },
  },
  {
    rule: "a text reply of approve runs the gated tool",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await askToDeploy(conversation);
      await conversation.say("approve");
      await expectDeployed(conversation);
    },
  },
  {
    rule: "a text reply of deny stops the gated tool without running it",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await askToDeploy(conversation);
      await conversation.say("deny");
      await expectNotDeployed(conversation);
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
        [PUBLISH_PROMPT]: DENY_LABELS,
      });
      await expectDeployed(conversation);
      expect(conversation.runsOf(SECOND_GATED_TOOL)).toBe(0);
    },
  },
  {
    rule: "text replies answer two pending approvals one at a time, in the order shown",
    source: "docs/tools/human-in-the-loop.md#several-requests-at-once",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await conversation.say(DEPLOY_AND_PUBLISH);
      await conversation.replyToEach({ [APPROVAL_PROMPT]: "approve", [PUBLISH_PROMPT]: "deny" });
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
      await expectDeployed(conversation);
    },
  },
  {
    rule: "text replies answer a question and an approval raised together, in the order shown",
    source: "docs/tools/human-in-the-loop.md#several-requests-at-once",
    requires: ["text-replies"],
    async run(conversation) {
      await conversation.say(ASK_AND_DEPLOY);
      await conversation.replyToEach({ [PROMPT]: "Saturday", [APPROVAL_PROMPT]: "approve" });
      await expectDeployed(conversation);
    },
  },
  {
    rule: "a message while an approval is pending cancels it, so typing approve afterwards runs nothing and the next message gets a reply",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await askToDeploy(conversation);
      await conversation.say(ASIDE);
      await conversation.waitForReplyTo(ASIDE);
      await conversation.say("approve");
      await conversation.waitForRest();
      expect(
        conversation.runsOf(GATED_TOOL),
        `${GATED_TOOL} ran on an approval the aside cancelled`,
      ).toBe(0);
      await conversation.say(FOLLOW_UP);
      await conversation.waitForReplyTo(FOLLOW_UP);
    },
  },
  {
    rule: "pressing Approve on an approval a message cancelled runs nothing",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["buttons", "text-replies"],
    variesByConversation: true,
    async run(conversation) {
      const options = await askToDeploy(conversation);
      await conversation.say(ASIDE);
      await conversation.waitForReplyTo(ASIDE);
      await conversation.press(option(options, APPROVE_LABELS));
      await conversation.waitForRest();
      expect(
        conversation.runsOf(GATED_TOOL),
        `${GATED_TOOL} ran on an approval the aside cancelled`,
      ).toBe(0);
    },
  },
] as const satisfies readonly ContractRule[];

const answeredPromptRules = [
  {
    rule: "pressing an option clears the question's buttons",
    source: "#1 (Slack's answered question card)",
    requires: ["buttons"],
    async run(conversation) {
      await answerSaturday(conversation, "press");
      await expectButtonsCleared(conversation, PROMPT);
    },
  },
  {
    rule: "answering a question by text clears its buttons",
    source: "#1 (Slack's answered question card)",
    requires: ["buttons", "text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await answerSaturday(conversation, "text");
      await expectButtonsCleared(conversation, PROMPT);
    },
  },
  {
    rule: "pressing an option names who answered on the question",
    source: "#1 (Slack's answered question card)",
    requires: ["buttons"],
    async run(conversation) {
      await answerSaturday(conversation, "press");
      await expectResponderNamed(conversation, PROMPT);
    },
  },
  {
    rule: "answering a question by text names who answered on the question",
    source: "#1 (Slack's answered question card)",
    requires: ["buttons", "text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await answerSaturday(conversation, "text");
      await expectResponderNamed(conversation, PROMPT);
    },
  },
  {
    rule: "pressing Approve clears the approval's buttons",
    source: "#2212 (Slack's settled approval card)",
    requires: ["buttons"],
    async run(conversation) {
      await approveDeploy(conversation, "press");
      await expectButtonsCleared(conversation, APPROVAL_PROMPT);
    },
  },
  {
    rule: "approving by text clears the approval's buttons",
    source: "#2212 (Slack's settled approval card)",
    requires: ["buttons", "text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await approveDeploy(conversation, "text");
      await expectButtonsCleared(conversation, APPROVAL_PROMPT);
    },
  },
  {
    rule: "pressing Approve names who approved on the approval",
    source: "#2212 (Slack's settled approval card)",
    requires: ["buttons"],
    async run(conversation) {
      await approveDeploy(conversation, "press");
      await expectResponderNamed(conversation, APPROVAL_PROMPT);
    },
  },
  {
    rule: "approving by text names who approved on the approval",
    source: "#2212 (Slack's settled approval card)",
    requires: ["buttons", "text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await approveDeploy(conversation, "text");
      await expectResponderNamed(conversation, APPROVAL_PROMPT);
    },
  },
] as const satisfies readonly ContractRule[];

async function pressAfterRunEnded(
  conversation: ChannelConversation,
  kind: "approval" | "question",
) {
  const options =
    kind === "approval" ? await askToDeploy(conversation) : await askWhichDay(conversation);
  await conversation.cancelRunsInWorld();
  await conversation.press(option(options, kind === "approval" ? APPROVE_LABELS : "Saturday"));
}

const NO_LONGER_ACTIVE = /no longer active/iu;

const inactivePromptRules = [
  {
    rule: "pressing Approve after the session's run ended outside eve runs nothing and clears the approval's buttons",
    source: "#4835",
    requires: ["buttons"],
    async run(conversation) {
      await pressAfterRunEnded(conversation, "approval");
      await conversation.waitForShown(NO_LONGER_ACTIVE);
      expect(conversation.runsOf(GATED_TOOL), `${GATED_TOOL} ran with no session`).toBe(0);
      await expectButtonsCleared(conversation, APPROVAL_PROMPT);
    },
  },
  {
    rule: "pressing an option after the session's run ended outside eve clears the question's buttons",
    source: "#4835",
    requires: ["buttons"],
    async run(conversation) {
      await pressAfterRunEnded(conversation, "question");
      await conversation.waitForShown(NO_LONGER_ACTIVE);
      await expectButtonsCleared(conversation, PROMPT);
    },
  },
  {
    rule: "pressing an option after the session's run ended outside eve tells the person it is no longer active",
    source: "#4835",
    requires: ["buttons"],
    async run(conversation) {
      await pressAfterRunEnded(conversation, "question");
      await conversation.waitForShown(NO_LONGER_ACTIVE);
    },
  },
  {
    rule: "a question pressed after the session's run ended outside eve keeps its prompt and says it is no longer active",
    source: "#4835",
    requires: ["buttons"],
    async run(conversation) {
      await pressAfterRunEnded(conversation, "question");
      await conversation.waitForShown(NO_LONGER_ACTIVE);
      const { text } = await conversation.shownPrompt(PROMPT);
      const message = `the inactive prompt reads ${JSON.stringify(text)}`;
      expect(text, message).toContain(PROMPT);
      expect(text, message).toMatch(NO_LONGER_ACTIVE);
    },
  },
] as const satisfies readonly ContractRule[];

const budgetRules = [
  {
    rule: "running out of budget opens budget prompt",
    source: "docs/agent-config.md#runtime-limits",
    requires: [],
    agent: ONE_TOKEN_BUDGET,
    async run(conversation) {
      const options = await exhaustBudget(conversation);
      const labels = options.map((option) => option.label).sort();
      expect(labels, `the budget prompt showed ${JSON.stringify(labels)}`).toEqual([
        "Approve",
        "Stop",
      ]);
      expect(await conversation.replyCount(), "the agent replied before anyone approved").toBe(0);
    },
  },
  {
    rule: "pressing approve on budget prompt allows agent to continue",
    source: "docs/agent-config.md#runtime-limits",
    requires: ["buttons"],
    agent: ONE_TOKEN_BUDGET,
    async run(conversation) {
      const options = await exhaustBudget(conversation);
      const approve = options.find((option) => option.label === "Approve");
      expect(approve, "an Approve option to press").toBeDefined();
      await conversation.press(approve!);
      await expectWorkContinued(conversation);
    },
  },
  {
    rule: "reply of approve on budget prompt allows agent to continue",
    source: "docs/agent-config.md#runtime-limits",
    requires: ["text-replies"],
    variesByConversation: true,
    agent: ONE_TOKEN_BUDGET,
    async run(conversation) {
      await exhaustBudget(conversation);
      await conversation.say("approve");
      await expectWorkContinued(conversation);
    },
  },
  {
    rule: "pressing stop on budget prompt halts work, next message asks again",
    source: "docs/agent-config.md#runtime-limits",
    requires: ["buttons", "text-replies"],
    variesByConversation: true,
    agent: ONE_TOKEN_BUDGET,
    async run(conversation) {
      const options = await exhaustBudget(conversation);
      const stop = options.find((option) => option.label === "Stop");
      expect(stop, "a Stop option to press").toBeDefined();
      await conversation.press(stop!);
      await expectStoppedAndAskedAgain(conversation);
    },
  },
  {
    rule: "reply of stop on budget prompt halts work, next message asks again",
    source: "docs/agent-config.md#runtime-limits",
    requires: ["text-replies"],
    variesByConversation: true,
    agent: ONE_TOKEN_BUDGET,
    async run(conversation) {
      await exhaustBudget(conversation);
      await conversation.say("stop");
      await expectStoppedAndAskedAgain(conversation);
    },
  },
  {
    rule: "query sent during budget prompt answered after budget approval",
    source: "docs/agent-config.md#runtime-limits",
    requires: ["text-replies"],
    variesByConversation: true,
    agent: ONE_TOKEN_BUDGET,
    async run(conversation) {
      await exhaustBudget(conversation);
      await conversation.say(LATER_MESSAGE);
      await conversation.say("approve");
      await conversation.waitForReplyTo(LATER_MESSAGE);
    },
  },
] as const satisfies readonly ContractRule[];

const signInRules = [
  {
    rule: "a sign-in names the service and shows its sign-in link",
    source: "docs/connections/index.mdx#self-hosted-interactive-oauth",
    requires: [],
    variesByConversation: true,
    surfaces: ["shared", "private"],
    async run(conversation) {
      await requestSignIn(conversation, READ_CALENDAR);
      const shown = await conversation.waitForShown(CALENDAR.url);
      await conversation.waitForShown(CALENDAR.displayName);
      expect(shown, "the sign-in link was shown").toContain(CALENDAR.url);
    },
  },
  {
    rule: "a sign-in shows its confirmation code",
    source: "docs/connections/index.mdx#self-hosted-interactive-oauth",
    requires: [],
    variesByConversation: true,
    surfaces: ["shared", "private"],
    async run(conversation) {
      await requestSignIn(conversation, READ_CALENDAR);
      await conversation.waitForShown(CALENDAR.userCode);
    },
  },
  {
    rule: "only the person signing in sees the sign-in link and code",
    source:
      "docs/channels/slack/reference.mdx#render-and-decode-hitl-controls-yourself (a sign-in challenge is a credential)",
    requires: [],
    variesByConversation: true,
    surfaces: ["public", "shared"],
    async run(conversation) {
      await requestSignIn(conversation, READ_CALENDAR);
      await conversation.waitForRest();
      const shared = await conversation.sharedText();
      expect(shared, "a message everyone sees carried the sign-in link").not.toContain(
        CALENDAR.url,
      );
      expect(shared, "a message everyone sees carried the sign-in code").not.toContain(
        CALENDAR.userCode,
      );
    },
  },
  {
    rule: "someone else pressing a sign-in isn't shown its link or code",
    source:
      "docs/channels/slack/reference.mdx#render-and-decode-hitl-controls-yourself (a sign-in challenge is a credential)",
    requires: ["another-person", "buttons"],
    variesByConversation: true,
    surfaces: ["shared"],
    async run(conversation) {
      await conversation.say(READ_CALENDAR);
      await conversation.waitForSignIn();
      await conversation.waitForRest();
      const challenges = async () =>
        (await conversation.shownTexts()).filter(
          (text) => text.includes(CALENDAR.url) || text.includes(CALENDAR.userCode),
        ).length;
      const before = await challenges();
      const open = (await conversation.shownOptions()).find((option) =>
        SIGN_IN_OPENERS.test(option.label),
      );
      expect(open, "a Sign in button for Bob to press").toBeDefined();
      await conversation.press(open!, "bob");
      await conversation.waitForRest();
      expect(await challenges(), "Bob's press showed him the sign-in link or code").toBe(before);
    },
  },
  {
    rule: "a sign-in without a link shows its instructions",
    source: "docs/connections/index.mdx#self-hosted-interactive-oauth",
    requires: [],
    variesByConversation: true,
    async run(conversation) {
      await requestSignIn(conversation, READ_MAIL);
      await conversation.waitForShown(MAIL.instructions);
    },
  },
  {
    rule: "after signing in, the agent carries on with the request",
    source: "docs/connections/index.mdx#interactive-oauth-via-vercel-connect",
    requires: [],
    async run(conversation) {
      await conversation.say(READ_CALENDAR);
      await conversation.waitForSignIn();
      expect(conversation.runsOf("read_calendar"), "read_calendar ran before sign-in").toBe(0);
      await conversation.completeSignIn();
      await expectSignInToolResult(conversation);
    },
  },
  {
    rule: "completing a sign-in tells the person it succeeded",
    source: "docs/connections/index.mdx#interactive-oauth-via-vercel-connect",
    requires: [],
    variesByConversation: true,
    async run(conversation) {
      await conversation.say(READ_CALENDAR);
      await conversation.waitForSignIn();
      await conversation.completeSignIn();
      await conversation.waitForShown(/\b(?:authorized|complete|connected)\b/iu);
    },
  },
  {
    rule: "completing a sign-in stops showing its link and code",
    source: "#5995",
    requires: [],
    variesByConversation: true,
    surfaces: ["shared", "private"],
    async run(conversation) {
      await requestSignIn(conversation, READ_CALENDAR);
      await conversation.waitForShown(CALENDAR.url);
      await conversation.completeSignIn();
      await expectSignInToolResult(conversation);
      await conversation.waitForRest();
      await expectSignInPromptGone(conversation, "after signing in");
    },
  },
  {
    rule: "pressing Cancel on a sign-in removes its prompt",
    source: "#5995",
    requires: ["buttons", "sign-in-cancel"],
    async run(conversation) {
      await conversation.say(READ_CALENDAR);
      await conversation.waitForSignIn();
      await conversation.waitForRest();
      await pressSignInCancel(conversation);
      await conversation.waitForRest();
      await expectSignInPromptGone(conversation, "after pressing Cancel");
      expect(conversation.runsOf("read_calendar"), "read_calendar ran after Cancel").toBe(0);
    },
  },
  {
    rule: "pressing Cancel on a sign-in after the session's run ended removes its prompt",
    source: "#5995",
    requires: ["buttons", "sign-in-cancel"],
    async run(conversation) {
      await conversation.say(READ_CALENDAR);
      await conversation.waitForSignIn();
      await conversation.waitForRest();
      await conversation.cancelRunsInWorld();
      await pressSignInCancel(conversation);
      await expectSignInPromptGone(conversation, "after pressing Cancel");
    },
  },
  {
    rule: "message after ignored sign-in gets an answer, signing in late doesn't run",
    source: "docs/connections/index.mdx#interactive-oauth-via-vercel-connect",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await abandonSignIn(conversation);
      await conversation.waitForReplyTo(CHANGE_OF_PLANS);
      await conversation.completeSignIn();
      await conversation.waitForRest();
      expect(
        conversation.runsOf("read_calendar"),
        "read_calendar ran after its sign-in was cancelled",
      ).toBe(0);
    },
  },
  {
    rule: "message after ignored sign-in tells user it was cancelled",
    source: "docs/connections/index.mdx#interactive-oauth-via-vercel-connect",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await abandonSignIn(conversation);
      await conversation.waitForShown(/\b(?:cancel|declin)/iu);
    },
  },
] as const satisfies readonly ContractRule[];

const approvalPermissionRules = [
  {
    rule: "the requester typing approve on a requester-only approval runs the tool",
    source: "docs/tools/human-in-the-loop.md#authorizing-approval-responses",
    requires: ["text-replies"],
    async run(conversation) {
      await askToReleaseHotfix(conversation);
      await conversation.say("approve");
      await expectReleased(conversation);
    },
  },
  {
    rule: "another person pressing Deny or Approve on a requester-only approval leaves it pending",
    source: "docs/tools/human-in-the-loop.md#authorizing-approval-responses",
    requires: ["another-person", "buttons"],
    async run(conversation) {
      const options = await askToReleaseHotfix(conversation);
      const approve = option(options, APPROVE_LABELS);
      await conversation.press(option(options, DENY_LABELS), "bob");
      await conversation.press(approve, "bob");
      await expectStillPending(conversation);
      await conversation.press(approve);
      await expectReleased(conversation);
    },
  },
  {
    rule: "another person typing deny or approve doesn't settle a requester-only approval",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["another-person", "text-replies"],
    async run(conversation) {
      await askToReleaseHotfix(conversation);
      await conversation.say("deny", "bob");
      await conversation.say("approve", "bob");
      await expectStillPending(conversation);
      await conversation.say("approve");
      await expectReleased(conversation);
    },
  },
  {
    rule: "another person's rejected press leaves the approval's buttons in place",
    source: "docs/tools/human-in-the-loop.md#authorizing-approval-responses",
    requires: ["another-person", "buttons"],
    async run(conversation) {
      const options = await askToReleaseHotfix(conversation);
      await conversation.press(option(options, APPROVE_LABELS), "bob");
      await expectStillPending(conversation);
      await expectButtonsKept(conversation, HOTFIX_PROMPT);
    },
  },
  {
    rule: "another person pressing Approve on an open approval runs the tool",
    source: "docs/tools/human-in-the-loop.md#authorizing-approval-responses",
    requires: ["another-person", "buttons"],
    async run(conversation) {
      const options = await askToRollBack(conversation);
      await conversation.press(option(options, APPROVE_LABELS), "bob");
      await expectRan(conversation, OPEN_GATED_TOOL, { rolledBack: true });
    },
  },
] as const satisfies readonly ContractRule[];

const callerRules = [
  {
    rule: "a tool sees the person who sent the message as its caller",
    source: "docs/tools/index.mdx",
    requires: [],
    variesByConversation: true,
    async run(conversation) {
      const [caller] = await lookUpNotesAs(conversation, ["alice"]);
      expect(caller, `${PLAIN_TOOL} ran with no caller`).not.toBeNull();
      const [principalId] = JSON.parse(caller!) as [string];
      expect(
        principalId === conversation.personId || principalId.endsWith(`:${conversation.personId}`),
        `${PLAIN_TOOL} ran as ${principalId}, which doesn't name ${conversation.personId}`,
      ).toBe(true);
    },
  },
  {
    rule: "another person's message reaches tools as a different caller, and each person stays the same caller",
    source: "docs/tools/index.mdx",
    requires: ["another-person"],
    async run(conversation) {
      const [alice, bob, aliceAgain] = await lookUpNotesAs(conversation, ["alice", "bob", "alice"]);
      expect(bob, `${PLAIN_TOOL} ran with no caller for Bob`).not.toBeNull();
      expect(bob, "Bob's message ran as Alice").not.toBe(alice);
      expect(aliceAgain, "Alice ran as a different caller the second time").toBe(alice);
    },
  },
] as const satisfies readonly ContractRule[];

async function spacesSeenBy(conversation: ChannelConversation, people: readonly Person[]) {
  await lookUpNotesAs(conversation, people);
  return conversation.spacesOf(PLAIN_TOOL);
}

const spaceRules = [
  {
    rule: "a tool sees the conversation's space as the platform names it",
    source: "docs/channels/index.mdx#spaces",
    requires: [],
    variesByConversation: true,
    async run(conversation) {
      const [space] = await spacesSeenBy(conversation, ["alice"]);
      expect(space, `${PLAIN_TOOL} saw the space ${JSON.stringify(space)}`).toEqual(
        conversation.space ?? null,
      );
    },
  },
  {
    rule: "another person in the conversation sees the same space",
    source: "docs/channels/index.mdx#spaces",
    requires: ["another-person"],
    async run(conversation) {
      const spaces = await spacesSeenBy(conversation, ["alice", "bob"]);
      expect(spaces, `${PLAIN_TOOL} saw the spaces ${JSON.stringify(spaces)}`).toEqual([
        conversation.space ?? null,
        conversation.space ?? null,
      ]);
    },
  },
] as const satisfies readonly ContractRule[];

const attachmentRules = [
  {
    rule: "an image a person sends reaches the agent with its bytes and type",
    source: "docs/channels/index.mdx",
    requires: ["attachments"],
    variesByConversation: true,
    async run(conversation) {
      await expectFileReachesAgent(conversation, DIAGRAM);
    },
  },
  {
    rule: "a PDF a person sends reaches the agent with its bytes and type",
    source: "docs/channels/index.mdx",
    requires: ["attachments"],
    async run(conversation) {
      await expectFileReachesAgent(conversation, REPORT);
    },
  },
  {
    rule: "a file that can't be downloaded reaches the agent as a note, not a link, and the next message still works",
    source: "#855, #3419",
    requires: ["attachments"],
    async run(conversation) {
      const seen = await attachmentsSeen(conversation, [{ ...DIAGRAM, downloadable: false }]);
      expect(seen, `the agent saw ${JSON.stringify(seen)}`).toEqual([
        { note: expect.stringMatching(/^Attachment\b/u) },
      ]);
      await conversation.say(FOLLOW_UP);
      await conversation.waitForReplyTo(FOLLOW_UP);
    },
  },
  {
    rule: "a file sent earlier in the conversation is still there on a later message",
    source: "docs/channels/index.mdx",
    requires: ["attachments"],
    async run(conversation) {
      const text = `Alice attached ${DIAGRAM.name}.`;
      await conversation.say(text, "alice", [DIAGRAM]);
      await conversation.waitForReplyTo(text);
      await conversation.say(FOLLOW_UP);
      await conversation.waitForReplyTo(FOLLOW_UP);
      const seen = await attachmentsSeen(conversation);
      expect(
        seen.map(({ bytes, mediaType, sha256 }) => ({ bytes, mediaType, sha256 })),
        `two messages later the agent saw ${JSON.stringify(seen)}`,
      ).toEqual([asSeen(DIAGRAM)]);
    },
  },
] as const satisfies readonly ContractRule[];

export const channelContractSections = [
  { title: "Questions", rules: questionRules },
  { title: "Tool approvals", rules: approvalRules },
  { title: "Approval permissions", rules: approvalPermissionRules },
  { title: "Answered prompts", rules: answeredPromptRules },
  { title: "Inactive prompts", rules: inactivePromptRules },
  { title: "Budget prompts", rules: budgetRules },
  { title: "Sign-ins", rules: signInRules },
  { title: "Tool callers", rules: callerRules },
  { title: "Conversation spaces", rules: spaceRules },
  { title: "Attachments", rules: attachmentRules },
] as const;

type ChannelContractRule = (typeof channelContractSections)[number]["rules"][number];

export const channelContract = channelContractSections.flatMap(
  (section): readonly ChannelContractRule[] => section.rules,
);

export type ContractRuleName = ChannelContractRule["rule"];
