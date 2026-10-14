import { defaultGitHubAuth, type GitHubChannelConfig } from "eve/channels/github";
import { z } from "zod";

const activeMembership = z.object({ state: z.literal("active") });

export function operatorComments(botName: string): NonNullable<GitHubChannelConfig["onComment"]> {
  const escapedName = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`@${escapedName}(?![\\w-])`, "i");

  return async (ctx, comment) => {
    if (
      !mention.test(comment.body) ||
      ctx.sender.type !== "User" ||
      comment.author?.type !== "User" ||
      comment.author.id !== ctx.sender.id ||
      comment.author.login.toLowerCase() !== ctx.sender.login.toLowerCase()
    ) {
      return null;
    }

    const org = process.env.GITHUB_ORG?.trim();
    const team = process.env.GITHUB_OPERATOR_TEAM?.trim();
    if (!org || !team) {
      console.warn("GitHub invocation requires GITHUB_ORG and GITHUB_OPERATOR_TEAM.");
      return null;
    }
    if (ctx.repository.owner.toLowerCase() !== org.toLowerCase()) return null;

    try {
      const response = await ctx.github.request({
        method: "GET",
        path: `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(ctx.sender.login)}`,
      });
      if (!response.ok || !activeMembership.safeParse(response.body).success) return null;
    } catch {
      console.warn(
        "GitHub operator membership lookup failed. Check the team slug and the App's organization Members: read permission.",
      );
      return null;
    }

    return { auth: defaultGitHubAuth(ctx) };
  };
}
