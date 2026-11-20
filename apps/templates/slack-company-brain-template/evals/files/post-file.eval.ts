import { defineEval, type ToolStub } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { alice, BOT_USER_ID, slackMessage, wordCount } from "../lib/slack.ts";

// The agent may check the file with `bash` first. Evals run without a sandbox,
// so `bash` returns a fixed listing.
const STUBS: ToolStub[] = [
  {
    id: "bash",
    tool: "bash",
    outcome: {
      response: {
        exitCode: 0,
        status: "completed",
        stderr: "",
        stdout:
          "-rw-r--r-- 1 user user 18234 Mar  9 10:02 /workspace/signups.csv\n" +
          "date,signups\n2026-03-02,412\n2026-03-03,389\n",
        truncated: false,
      },
    },
  },
  { id: "post", tool: "post_slack_file", outcome: { response: { posted: true } } },
];

export default defineEval({
  description: "Asked to share a sandbox file, the agent posts that file and replies briefly.",
  async test(t) {
    const session = await t.session({ stubs: STUBS });
    const turn = await session.send(
      slackMessage({
        from: alice,
        text:
          `<@${BOT_USER_ID}> I saved this week's signups export at /workspace/signups.csv. ` +
          "Can you share it in this thread so Bob can download it?",
        ts: "1767268800.000100",
        mentioned: true,
      }),
    );
    turn.succeeded();
    turn.calledTool("post_slack_file", {
      input: (input: unknown) => (input as { path?: string }).path === "/workspace/signups.csv",
      count: 1,
    });
    t.check(
      wordCount(turn.reply),
      satisfies((words: number) => words > 0 && words <= 50, "a short reply after the file"),
    );
  },
});
