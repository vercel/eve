import { slackSendMessage } from "eve/experimental/slack";

export default slackSendMessage({
  botToken: async () => {
    throw new Error("This self-contained fixture has no Slack installation.");
  },
});
