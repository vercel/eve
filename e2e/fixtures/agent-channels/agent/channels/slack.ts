import { slackChannel } from "eve/channels/slack";

/** Validates and previews Alice's review form; the eval signs its own Slack requests. */
export default slackChannel({
  credentials: { signingSecret: "e2e-slack-signing-secret" },
  onView(event) {
    if (event.type !== "submit" || event.callbackId !== "sales_review") return;
    const line = event.values.line;
    if (!line?.trim()) {
      return { action: "errors", errors: { draft: "Enter a follow-up line." } };
    }
    const view = event.raw.view as { state?: unknown } | undefined;
    return {
      action: "update",
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Review preview" },
        blocks: [
          {
            type: "section",
            text: {
              type: "plain_text",
              text: JSON.stringify({
                line,
                reviewId: event.privateMetadata,
                reviewer: event.user.id,
                state: view?.state,
              }),
            },
          },
        ],
      },
    };
  },
});
