import { defineEval } from "eve/evals";

import { postChannel } from "../custom-channels/shared";

const REACT_TOOL = "slack-reactions__react_with_emoji";

export default defineEval({
  description: "Alice shares a team launch in Slack, and the agent marks it with a reaction.",
  async test(t) {
    const { sessionId } = await postChannel<{ sessionId: string }>(t.target, "/team-chat/message", {
      channelId: "C0LAUNCH",
      messageTs: "1751401594.001200",
      text: "Alice: Bob and I just shipped the new onboarding flow to every customer this morning! Thanks for all the help along the way.",
    });
    const turn = await t.target.attach(sessionId).watch().result();
    turn.succeeded();
    turn.calledTool(REACT_TOOL, { output: { success: true } });
    turn.noFailedCalls();
  },
});
