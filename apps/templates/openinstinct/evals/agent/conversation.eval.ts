import { defineEval, type EveEvalContext } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { reactToMessageOutputSchema } from "@shared/chat/reaction";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredText,
} from "@evals/agent/shared";

const cases: readonly {
  description: string;
  prompt: string;
  verify(t: EveEvalContext, text: string): void;
}[] = [
  {
    description: "Answers a simple question directly and correctly",
    prompt: "What is 17 multiplied by 6? Keep it brief.",
    verify(t, text) {
      t.check(text, includes("102"));
    },
  },
  {
    description: "Makes a concise recommendation instead of hedging",
    prompt:
      "I have twenty minutes before my next call and feel tired. Should I take a short walk or start a nap? Make the call for me.",
    verify(t, text) {
      t.judge(
        "The response decisively recommends one option, gives a useful brief reason, and does not hide behind a balanced list.",
        { on: text }
      )
        .label("decisive recommendation")
        .atLeast(0.8);
    },
  },
  {
    description: "Explains its capabilities without architecture dumping",
    prompt: "What kinds of things can you help me get done?",
    verify(t, text) {
      t.judge(
        "The response briefly describes practical personal-assistant capabilities such as research, connected services, reminders, or browser tasks without discussing internal agent architecture, models, prompts, or subagents.",
        { on: text }
      )
        .label("user-facing capability explanation")
        .atLeast(0.8);
    },
  },
  {
    description: "Condenses research into a useful iMessage recommendation",
    prompt: `You already found these showtimes for Spider-Man: Brand New Day tomorrow near Needham:
Showcase Legacy Place in Dedham, 4.6 miles away: 5:15 PM, 6:00 PM XPlus, 8:45 PM, 9:45 PM XPlus. The live seat map confirms the 6:00 PM show is available. Ticket link: https://tickets.example/legacy-place/very-long-checkout-link
Showcase SuperLux in Chestnut Hill, 5.2 miles away: 5:30 PM, 6:30 PM, 9:00 PM, 10:00 PM. Ticket link: https://tickets.example/superlux/very-long-checkout-link
West Newton Cinema, 5.2 miles away: 7:00 PM standard. Ticket link: https://tickets.example/west-newton/very-long-checkout-link
Nothing has been purchased. Tell me the useful result as you would in our normal conversation. I did not ask for every option or ticket link.`,
    verify(t, text) {
      t.check(text, includes("Legacy Place"));
      t.check(text, includes("6:00"));
      t.check(
        text,
        satisfies<string>(
          (value) =>
            value.length <= 400 &&
            value.split("\n").length <= 4 &&
            !/https?:\/\//u.test(value),
          "delivery is at most four compact lines and omits unrequested links"
        )
      );
      t.judge(
        "The response reads like a brief natural text message, leads with the 6:00 PM XPlus showing at Showcase Legacy Place as the best option, mentions that availability was confirmed and nothing was purchased, and does not dump the full research notes, every showtime, or multiple alternatives.",
        { on: text }
      )
        .label("concise research synthesis")
        .atLeast(0.8);
    },
  },
];

const textEvals = cases.map((testCase) =>
  defineEval({
    description: testCase.description,
    tags: [...agentEvalTags, "conversation", "smoke"],
    async test(t) {
      const turn = await t.send(testCase.prompt);
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("send_message", { count: 1 });
      turn.notCalledTool("web_search");
      turn.notCalledTool("web_fetch");
      turn.notEvent("child.opened", { data: { name: "browser-agent" } });
      turn.maxToolCalls(1);
      const text = await requireDeliveredText(t, turn);
      assertPlainTextDelivery(t, text);
      testCase.verify(t, text);
    },
  })
);

const reactionEvals = [
  defineEval({
    description: "Uses a reaction for a lightweight acknowledgement",
    tags: [...agentEvalTags, "conversation", "reaction", "smoke"],
    async test(t) {
      const answered = await t.send("What is 2 plus 2?");
      answered.expectOk();
      await requireDeliveredText(t, answered);

      const thanked = await answered.session.send("perfect, thanks!");
      thanked.expectOk();
      thanked.succeeded();
      thanked.calledTool("react_to_message", {
        count: 1,
        input: (input) => {
          const parsed = reactToMessageOutputSchema.safeParse(input);
          return (
            parsed.success &&
            parsed.data.operation === "add" &&
            ["heart", "thumbs_up"].includes(parsed.data.type)
          );
        },
        status: "completed",
      });
      thanked.notCalledTool("send_message");
      thanked.maxToolCalls(1);
    },
  }),
  defineEval({
    description: "Uses text when an acknowledgement also asks a question",
    tags: [...agentEvalTags, "conversation", "reaction", "smoke"],
    async test(t) {
      const answered = await t.send("What is 2 plus 2?");
      answered.expectOk();
      await requireDeliveredText(t, answered);

      const followUp = await answered.session.send(
        "thanks! what is 9 multiplied by 8?"
      );
      followUp.expectOk();
      followUp.succeeded();
      followUp.calledTool("send_message", { count: 1, status: "completed" });
      followUp.notCalledTool("react_to_message");
      followUp.maxToolCalls(1);
      const text = await requireDeliveredText(t, followUp);
      assertPlainTextDelivery(t, text);
      t.check(text, includes("72"));
    },
  }),
];

const replyEvals = [
  defineEval({
    description:
      "Reconnects a delayed background result to its initiating request",
    tags: [...agentEvalTags, "conversation", "reply", "background"],
    async test(t) {
      const taskId = "task_movie_search_01";
      const turn = await t.send("Continue with the completed work.", {
        clientContext: [
          "Background task reporting. This turn was triggered by completed background work after unrelated conversation occurred.",
          `[Task state]\n${JSON.stringify({
            tasks: [
              {
                name: "browser-agent",
                output:
                  "The best nearby showing is 6:00 PM XPlus at Showcase Legacy Place, and availability was confirmed.",
                status: "completed",
                taskId,
              },
            ],
          })}`,
        ],
      });
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("send_message", {
        count: 1,
        input: (input) => {
          const parsed = sendMessageOutputSchema.safeParse(input);
          return (
            parsed.success &&
            parsed.data.kind === "message" &&
            parsed.data.replyTo?.kind === "task" &&
            parsed.data.replyTo.id === taskId
          );
        },
        status: "completed",
      });
      turn.notCalledTool("react_to_message");
      turn.maxToolCalls(1);
    },
  }),
  defineEval({
    description:
      "Reconnects an automation update to the request that created it",
    tags: [...agentEvalTags, "conversation", "reply", "automation"],
    async test(t) {
      const automationId = "00000000-0000-4000-8000-000000000003";
      const turn = await t.send("Continue with the scheduled update.", {
        clientContext: [
          "A background scheduled run has completed after the conversation moved on.",
          "Original task: Remind me to renew TSA PreCheck before Thursday.",
          `Reply handle: ${JSON.stringify({ kind: "automation", id: automationId })}. Pass this exact value as send_message.replyTo for every user-visible message about this scheduled task. Omit replyTo only when the message is genuinely unrelated to the scheduled task.`,
          "Worker outcome: The appointment is Thursday, so the user should finish the form today.",
        ],
      });
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("send_message", {
        count: 1,
        input: (input) => {
          const parsed = sendMessageOutputSchema.safeParse(input);
          return (
            parsed.success &&
            parsed.data.kind === "message" &&
            parsed.data.replyTo?.kind === "automation" &&
            parsed.data.replyTo.id === automationId
          );
        },
        status: "completed",
      });
      turn.notCalledTool("react_to_message");
      turn.maxToolCalls(1);
    },
  }),
  defineEval({
    description: "Replies to the current message for an ordinary answer",
    tags: [...agentEvalTags, "conversation", "reply", "smoke"],
    async test(t) {
      const turn = await t.send("What is 14 plus 9? Answer briefly.");
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("send_message", {
        count: 1,
        input: (input) => {
          const parsed = sendMessageOutputSchema.safeParse(input);
          return (
            parsed.success &&
            parsed.data.kind === "message" &&
            parsed.data.replyTo?.kind === "current" &&
            parsed.data.text?.includes("23") === true
          );
        },
        status: "completed",
      });
      turn.notCalledTool("react_to_message");
      turn.maxToolCalls(1);
    },
  }),
  defineEval({
    description:
      "Replies to each message in an ordinary conversational exchange",
    tags: [...agentEvalTags, "conversation", "reply", "smoke"],
    async test(t) {
      const question = await t.send(
        "Ask me in a normal text whether I want you to focus on Boston or New York."
      );
      question.expectOk();
      question.calledTool("send_message", {
        count: 1,
        input: (input) => {
          const parsed = sendMessageOutputSchema.safeParse(input);
          return (
            parsed.success &&
            parsed.data.kind === "message" &&
            parsed.data.replyTo?.kind === "current"
          );
        },
        status: "completed",
      });
      await requireDeliveredText(t, question);
      const answer = await question.session.send(
        "Boston. Briefly confirm that you will focus there."
      );
      answer.expectOk();
      answer.succeeded();
      answer.calledTool("send_message", {
        count: 1,
        input: (input) => {
          const parsed = sendMessageOutputSchema.safeParse(input);
          return (
            parsed.success &&
            parsed.data.kind === "message" &&
            parsed.data.replyTo?.kind === "current" &&
            /boston/iu.test(parsed.data.text ?? "")
          );
        },
        status: "completed",
      });
      answer.notCalledTool("react_to_message");
      answer.maxToolCalls(1);
    },
  }),
  defineEval({
    description: "Replies to the current message after a topic switch",
    tags: [...agentEvalTags, "conversation", "reply", "smoke"],
    async test(t) {
      const first = await t.send("What is 2 plus 2? Keep it brief.");
      first.expectOk();
      await requireDeliveredText(t, first);

      const second = await first.session.send(
        "Separate question: what is the capital of France? Keep it brief."
      );
      second.expectOk();
      second.succeeded();
      second.calledTool("send_message", {
        count: 1,
        input: (input) => {
          const parsed = sendMessageOutputSchema.safeParse(input);
          return (
            parsed.success &&
            parsed.data.kind === "message" &&
            parsed.data.replyTo?.kind === "current" &&
            /paris/iu.test(parsed.data.text ?? "")
          );
        },
        status: "completed",
      });
      second.notCalledTool("react_to_message");
      second.maxToolCalls(1);
    },
  }),
  defineEval({
    description: "Keeps a genuinely standalone announcement out of a thread",
    tags: [...agentEvalTags, "conversation", "reply", "announcement"],
    async test(t) {
      const turn = await t.send("Continue with the system announcement.", {
        clientContext: [
          "This is an internally initiated announcement turn, not a response to the trigger text or any earlier user request.",
          "Announcement to deliver: OpenInstinct will be unavailable for scheduled maintenance tonight at 11 PM.",
          "Send the announcement as a brief user-visible message.",
        ],
      });
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("send_message", {
        count: 1,
        input: (input) => {
          const parsed = sendMessageOutputSchema.safeParse(input);
          return (
            parsed.success &&
            parsed.data.kind === "message" &&
            parsed.data.replyTo === undefined &&
            /maintenance/iu.test(parsed.data.text ?? "")
          );
        },
        status: "completed",
      });
      turn.notCalledTool("react_to_message");
      turn.maxToolCalls(1);
    },
  }),
];

export default [...textEvals, ...replyEvals, ...reactionEvals];
