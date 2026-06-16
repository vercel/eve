import {
  Actions,
  Button,
  Card,
  CardText,
  loadThreadContextMessages,
  slackChannel,
} from "eve/channels/slack";

export default slackChannel({
  async onAppMention(ctx, message) {
    const author = message.author;
    if (!author) return null;
    const auth = {
      attributes: {},
      authenticator: "slack",
      principalId: author.userId,
      principalType: author.isBot ? "service" : "user",
    };

    // `since: "thread-root"` includes every prior message in the
    // thread, including ones the bot itself posted. Under
    // `since: "last-agent-reply"`, bot-authored setup messages would be
    // filtered out as agent replies and the model would miss that context.
    const priorMessages = await loadThreadContextMessages(ctx.thread, message, {
      since: "thread-root",
    });
    if (priorMessages.length === 0) return { auth };

    const transcript = priorMessages
      .map((entry) => `${entry.isMe ? "you" : (entry.user ?? "user")}: ${entry.markdown}`)
      .join("\n");

    const context = [
      "Recent Slack thread messages, oldest first. " +
        "Use them as background context for the current mention.\n\n" +
        transcript,
    ];

    return {
      auth,
      context,
    };
  },

  events: {
    "actions.requested"(event, ctx) {
      const labels = event.actions.map((a) => (a.kind === "tool-call" ? a.toolName : a.kind));
      ctx.thread.startTyping(`Running ${labels.join(", ")}…`);
    },

    "message.completed"(event, ctx) {
      if (event.finishReason === "tool-calls") return;
      if (event.message) {
        ctx.thread.post(event.message);
        ctx.thread.post(
          Card({
            children: [
              CardText(`Turn #${event.sequence}`, { style: "bold" }),
              Actions([
                Button({
                  id: "feedback_positive",
                  label: "👍 Helpful",
                  value: String(event.sequence),
                  style: "primary",
                }),
                Button({
                  id: "feedback_negative",
                  label: "👎 Not helpful",
                  value: String(event.sequence),
                }),
              ]),
            ],
          }),
        );
      }
    },
  },
});
