import { defineTool } from "eve/tools";
import { z } from "zod";

import { codeChannelApi } from "../lib/code-channels";
import { codeChannelTarget, NOT_IN_CODE_CHANNEL } from "../lib/slack";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export default defineTool({
  description:
    "Show the current changes in a checked-out repository on the code channel's diff tab, and put the repository and branch in its context bar. Call it after meaningful edits so the team can review the work in Slack.",
  inputSchema: z.object({
    repoPath: z.string().describe("Absolute path of the repository in the sandbox"),
    baseBranch: z.string().default("main"),
  }),
  async execute({ repoPath, baseBranch }, ctx) {
    const target = codeChannelTarget(ctx.session.auth.current);
    if (!target) return NOT_IN_CODE_CHANNEL;

    const sandbox = await ctx.getSandbox();
    const git = async (args: string) => {
      const result = await sandbox.run({ command: `git -C ${quote(repoPath)} ${args}` });
      if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args} failed`);
      return result.stdout.trim();
    };
    const headBranch = await git("rev-parse --abbrev-ref HEAD");
    const remote = await git("remote get-url origin").catch(() => "");
    const diff = await git(`diff --no-color ${quote(baseBranch)}`);
    if (!diff) return { ok: true, published: false, reason: "No changes against the base branch." };

    await codeChannelApi(target.call, "agents.conversations.setView", {
      channel_id: target.channelId,
      type: "diff",
      content: diff,
      base_branch: baseBranch,
      head_branch: headBranch,
    });
    const repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)?.[1];
    if (repo) {
      await codeChannelApi(target.call, "agents.conversations.setProperties", {
        channel_id: target.channelId,
        code_channel: {
          context_bar_items: [
            { key: "repo", label: repo, icon: "folder", url: `https://github.com/${repo}` },
            {
              key: "branch",
              label: headBranch,
              icon: "hierarchy",
              url: `https://github.com/${repo}/tree/${headBranch}`,
            },
          ],
        },
      });
    }
    return { ok: true, published: true, headBranch };
  },
});
