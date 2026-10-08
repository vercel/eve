import { createHash } from "node:crypto";

import { expect } from "vitest";

import {
  type ChannelCapability,
  type ChannelConversation,
  type ConversationOptions,
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
  /**
   * The behavior can differ between a shared thread and a DM, such as a typed
   * answer that must mention the bot in a channel, or a press whose presser a
   * platform names differently in a server. A channel's DM column runs only
   * these; its shared-thread column covers the rest.
   */
  readonly variesByConversation?: boolean;
  /** The surfaces the behavior is promised on; every surface when unset. */
  readonly surfaces?: readonly Surface[];
  /** How the test agent differs from the default for this rule. */
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

// Neither matches an option, a tool, or a number, so each steers the turn.
const ASIDE = "Alice also wants the changelog summarized.";
const FOLLOW_UP = "Alice asks what is still left to do.";

/** Each person in turn asks for {@link PLAIN_TOOL}; returns the caller each run saw. */
async function lookUpNotesAs(
  conversation: ChannelConversation,
  people: readonly Person[],
): Promise<readonly (string | null)[]> {
  for (const [index, person] of people.entries()) {
    // Numbered, so each run's reply, which quotes its message, can be told apart.
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

/** Once the session settles after Bob answers, the requester-only approval is still pending. */
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
async function expectButtonsCleared(conversation: ChannelConversation, prompt: string) {
  const labels = (await conversation.shownPrompt(prompt)).options.map((option) => option.label);
  expect(labels, `the answered prompt still offers ${JSON.stringify(labels)}`).toEqual([]);
}

/** A press an approval policy rejected leaves the prompt answerable by someone else. */
async function expectButtonsKept(conversation: ChannelConversation, prompt: string) {
  const labels = (await conversation.shownPrompt(prompt)).options.map((option) => option.label);
  const message = `the rejected prompt offers ${JSON.stringify(labels)}`;
  expect(
    labels.some((label) => APPROVE_LABELS.includes(label)),
    message,
  ).toBe(true);
  expect(
    labels.some((label) => CANCEL_LABELS.includes(label)),
    message,
  ).toBe(true);
}

/** Once answered, the prompt's message shows everyone in the conversation who answered it. */
async function expectResponderNamed(conversation: ChannelConversation, prompt: string) {
  const { text } = await conversation.shownPrompt(prompt);
  expect(
    conversation.personShownAs.some((name) => text.includes(name)),
    `the answered prompt never names who answered: ${JSON.stringify(text)}`,
  ).toBe(true);
}

/**
 * A one-token input budget lets the model call that crosses it finish, so a
 * turn that calls a tool is held before the model reads the tool's result.
 */
// The smallest valid JPEG (1x1) and PDF, so a channel's media checks accept them.
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
// The test model's answer to LIST_ATTACHMENTS: every file part it was given, as JSON.
const ATTACHMENTS_REPLY = /Attachments: (\[.*?\])(?:\s|$)/su;

/**
 * One file the test model saw, as it lists them: bytes and type, a link it was
 * left to fetch, or eve's note for a file it couldn't pass on.
 */
interface SeenFile {
  readonly bytes?: number;
  readonly mediaType?: string;
  readonly note?: string;
  readonly sha256?: string;
  readonly url?: string;
}

/**
 * Asks the agent which files it can see, sending `files` with the question, and
 * reads its answer from the channel's reply. Sending a file with the question
 * keeps the check to one message, which a channel that starts a session per
 * message, such as Discord's slash commands, can still answer.
 */
async function attachmentsSeen(
  conversation: ChannelConversation,
  files?: readonly SentFile[],
): Promise<readonly SeenFile[]> {
  await conversation.say(LIST_ATTACHMENTS, "alice", files);
  const shown = await conversation.waitForShown(ATTACHMENTS_REPLY);
  return JSON.parse(ATTACHMENTS_REPLY.exec(shown)![1]!) as SeenFile[];
}

/** What the agent should see for `file`: its exact bytes, with its type. */
function asSeen(file: SentFile): SeenFile {
  return {
    bytes: file.bytes.length,
    mediaType: file.mediaType,
    sha256: createHash("sha256").update(file.bytes).digest("hex").slice(0, 16),
  };
}

/** Sends `file` with a message, then checks the agent sees exactly it. */
async function expectFileReachesAgent(conversation: ChannelConversation, file: SentFile) {
  const seen = await attachmentsSeen(conversation, [file]);
  expect(
    seen.map(({ bytes, mediaType, sha256, url }) => ({ bytes, mediaType, sha256, url })),
    `the agent saw ${JSON.stringify(seen)}`,
  ).toEqual([{ ...asSeen(file), url: undefined }]);
}

const ONE_TOKEN_BUDGET = { limits: { maxInputTokensPerSession: 1 } } as const;
const BUDGET_PROMPT =
  "This session has hit the input-token limit (1) per session. This is a guardrail against " +
  "defective long-running sessions. If session activity looks fine, just approve to keep going.";
const LOOK_UP_NOTES = `Use ${PLAIN_TOOL} to find Bob's review notes.`;
const LATER_MESSAGE = "Carol wants the review by Friday.";

/** Starts a turn that spends the budget on its first model call and is held after its tool runs. */
async function exhaustBudget(conversation: ChannelConversation) {
  await conversation.say(LOOK_UP_NOTES);
  return await conversation.waitForQuestion(BUDGET_PROMPT);
}

/**
 * Once approved, the agent replies without redoing the work it did before the
 * prompt. A text answer's channel context (such as Telegram's message id)
 * reaches the model after the tool result, and the test model answers that
 * context instead of reporting the result, so this waits for any reply rather
 * than the tool's.
 */
async function expectWorkContinued(conversation: ChannelConversation) {
  await conversation.waitForReply();
  await conversation.waitForRest();
  expect(conversation.runsOf(PLAIN_TOOL), `${PLAIN_TOOL} ran again after approval`).toBe(1);
}

async function expectStoppedAndAskedAgain(conversation: ChannelConversation) {
  await conversation.say(LATER_MESSAGE);
  // Stopping keeps the session over budget, so the next message asks again.
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

/**
 * Asks for something that needs a sign-in, then opens the sign-in as a person
 * would. In a group the bot may first post a status with a button that sends
 * the sign-in to whoever asked, such as Telegram's Authorize.
 */
async function requestSignIn(conversation: ChannelConversation, message: string) {
  await conversation.say(message);
  await conversation.waitForSignIn();
  const open = (await conversation.shownOptions()).find((option) =>
    SIGN_IN_OPENERS.test(option.label),
  );
  if (open !== undefined) await conversation.press(open);
}

const SIGN_IN_OPENERS = /^(?:authori[sz]e|sign in)$/iu;

/** Starts a calendar sign-in, then moves on with a new message before finishing it. */
async function abandonSignIn(conversation: ChannelConversation) {
  await conversation.say(READ_CALENDAR);
  await conversation.waitForSignIn();
  // A person moves on once they've seen the sign-in, which in a group they reply to.
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
      // Once withdrawn, an option label is an ordinary message. A question left open would take it.
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
    variesByConversation: true,
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
    variesByConversation: true,
    async run(conversation) {
      await askToDeploy(conversation);
      await conversation.say("cancel");
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
    rule: "text replies answer two pending approvals one at a time, in the order shown",
    source: "docs/tools/human-in-the-loop.md#several-requests-at-once",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await conversation.say(DEPLOY_AND_PUBLISH);
      await conversation.replyToEach({ [APPROVAL_PROMPT]: "approve", [PUBLISH_PROMPT]: "cancel" });
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
    rule: "text replies answer a question and an approval raised together, in the order shown",
    source: "docs/tools/human-in-the-loop.md#several-requests-at-once",
    requires: ["text-replies"],
    async run(conversation) {
      await conversation.say(ASK_AND_DEPLOY);
      await conversation.replyToEach({ [PROMPT]: "Saturday", [APPROVAL_PROMPT]: "approve" });
      // The turn replies only once both calls settle.
      await expectDeployed(conversation);
    },
  },
  {
    rule: "a message while an approval is pending cancels it, so typing approve afterwards runs nothing and the next message gets a reply",
    // Policy since #4135. #4051 proposes keeping the approval open instead, which flips this rule.
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
      // The card's original button, as a client that hasn't refreshed still shows it.
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
      // Had the message closed or replaced the prompt, approve would be held behind it.
      await conversation.say("approve");
      await conversation.waitForReplyTo(LATER_MESSAGE);
    },
  },
] as const satisfies readonly ContractRule[];

const signInRules = [
  {
    rule: "a sign-in names the service and shows its sign-in link",
    source: "docs/connections/overview.mdx#self-hosted-interactive-oauth",
    requires: [],
    variesByConversation: true,
    // A public surface has nowhere private to show a link.
    surfaces: ["shared", "private"],
    async run(conversation) {
      await requestSignIn(conversation, READ_CALENDAR);
      const shown = await conversation.waitForShown(CALENDAR.url);
      // Slack names the service in the shared status and links privately, so accept either.
      await conversation.waitForShown(CALENDAR.displayName);
      expect(shown, "the sign-in link was shown").toContain(CALENDAR.url);
    },
  },
  {
    rule: "a sign-in shows its confirmation code",
    source: "docs/connections/overview.mdx#self-hosted-interactive-oauth",
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
      "docs/channels/slack.mdx#render-and-decode-hitl-controls-yourself (a sign-in challenge is a credential)",
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
    rule: "a sign-in without a link shows its instructions",
    source: "docs/connections/overview.mdx#self-hosted-interactive-oauth",
    requires: [],
    variesByConversation: true,
    async run(conversation) {
      await requestSignIn(conversation, READ_MAIL);
      await conversation.waitForShown(MAIL.instructions);
    },
  },
  {
    rule: "after signing in, the agent carries on with the request",
    source: "docs/connections/overview.mdx#interactive-oauth-via-vercel-connect",
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
    source: "docs/connections/overview.mdx#interactive-oauth-via-vercel-connect",
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
    rule: "message after ignored sign-in gets an answer, signing in late doesn't run",
    source: "docs/connections/overview.mdx#interactive-oauth-via-vercel-connect",
    requires: ["text-replies"],
    variesByConversation: true,
    async run(conversation) {
      await abandonSignIn(conversation);
      await conversation.waitForReplyTo(CHANGE_OF_PLANS);
      // Finishing the abandoned sign-in afterwards must not run the tool.
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
    source: "docs/connections/overview.mdx#interactive-oauth-via-vercel-connect",
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
    rule: "the requester typing approve on a policy-gated approval steers without running it",
    source: "docs/tools/human-in-the-loop.md#authorizing-approval-responses",
    requires: ["text-replies"],
    async run(conversation) {
      await askToReleaseHotfix(conversation);
      await conversation.say("approve");
      await conversation.waitForReplyTo("approve");
      expect(conversation.runsOf(REQUESTER_GATED_TOOL)).toBe(0);
    },
  },
  {
    rule: "another person pressing Cancel or Approve on a requester-only approval leaves it pending",
    source: "docs/tools/human-in-the-loop.md#authorizing-approval-responses",
    requires: ["another-person", "buttons"],
    async run(conversation) {
      const options = await askToReleaseHotfix(conversation);
      const approve = option(options, APPROVE_LABELS);
      await conversation.press(option(options, CANCEL_LABELS), "bob");
      await conversation.press(approve, "bob");
      await expectStillPending(conversation);
      // A cancel that got through would settle the call as denied before this approval.
      await conversation.press(approve);
      await expectReleased(conversation);
    },
  },
  {
    rule: "another person typing cancel or approve doesn't settle a requester-only approval",
    source: "docs/tools/human-in-the-loop.md#how-pause-and-resume-works",
    requires: ["another-person", "text-replies", "buttons"],
    async run(conversation) {
      const options = await askToReleaseHotfix(conversation);
      // Today another person's message waits for the turn to end, so it never reaches the
      // response policy; the approval stays pending either way.
      await conversation.say("cancel", "bob");
      await conversation.say("approve", "bob");
      await expectStillPending(conversation);
      // A cancel taken as Alice's would settle the call as denied before this approval.
      await conversation.press(option(options, APPROVE_LABELS));
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
    source: "docs/tools/overview.mdx",
    requires: [],
    // Platforms name the sender differently in a DM, e.g. Discord's user rather than member.
    variesByConversation: true,
    async run(conversation) {
      const [caller] = await lookUpNotesAs(conversation, ["alice"]);
      expect(caller, `${PLAIN_TOOL} ran with no caller`).not.toBeNull();
      const [principalId] = JSON.parse(caller!) as [string];
      // Platform principals are namespaced, e.g. `slack:T01:U_ALICE`; a client's is the bare id.
      expect(
        principalId === conversation.personId || principalId.endsWith(`:${conversation.personId}`),
        `${PLAIN_TOOL} ran as ${principalId}, which doesn't name ${conversation.personId}`,
      ).toBe(true);
    },
  },
  {
    rule: "another person's message reaches tools as a different caller, and each person stays the same caller",
    source: "docs/tools/overview.mdx",
    requires: ["another-person"],
    async run(conversation) {
      const [alice, bob, aliceAgain] = await lookUpNotesAs(conversation, ["alice", "bob", "alice"]);
      expect(bob, `${PLAIN_TOOL} ran with no caller for Bob`).not.toBeNull();
      expect(bob, "Bob's message ran as Alice").not.toBe(alice);
      expect(aliceAgain, "Alice ran as a different caller the second time").toBe(alice);
    },
  },
] as const satisfies readonly ContractRule[];

const attachmentRules = [
  {
    rule: "an image a person sends reaches the agent with its bytes and type",
    source: "docs/channels/overview.mdx",
    requires: ["attachments"],
    variesByConversation: true,
    async run(conversation) {
      await expectFileReachesAgent(conversation, DIAGRAM);
    },
  },
  {
    rule: "a PDF a person sends reaches the agent with its bytes and type",
    source: "docs/channels/overview.mdx",
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
      // A link left for the model provider fails again on every later turn (#3419),
      // and with nothing at all the agent can't tell the person their file didn't arrive.
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
    source: "docs/channels/overview.mdx",
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

/** The contract's rules, grouped by the kind of behavior they cover. */
export const channelContractSections = [
  { title: "Questions", rules: questionRules },
  { title: "Tool approvals", rules: approvalRules },
  { title: "Approval permissions", rules: approvalPermissionRules },
  { title: "Answered prompts", rules: answeredPromptRules },
  { title: "Budget prompts", rules: budgetRules },
  { title: "Sign-ins", rules: signInRules },
  { title: "Tool callers", rules: callerRules },
  { title: "Attachments", rules: attachmentRules },
] as const;

type ChannelContractRule = (typeof channelContractSections)[number]["rules"][number];

export const channelContract = channelContractSections.flatMap(
  (section): readonly ChannelContractRule[] => section.rules,
);

export type ContractRuleName = ChannelContractRule["rule"];
