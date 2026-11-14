import { connectGitHubCredentials } from "@vercel/connect/eve";
import {
  defaultGitHubAuth,
  type GitHubComment,
  githubChannel,
} from "eve/channels/github";
import { requireEnv } from "../lib/constants.js";

const BOT_NAME = "Kody";
const digestRepo = requireEnv("DIGEST_REPO", "acme/widgets").toLowerCase();
const MENTION_PATTERN = /@kody(?=$|[^A-Za-z0-9_-])/iu;
const MAINTAINER_PERMISSIONS = new Set(["admin", "maintain", "write"]);

const isIgnoredComment = (comment: GitHubComment): boolean => {
  if (comment.body.includes("<!-- eve:github:")) {
    return true;
  }
  const { author } = comment;
  return (
    author === undefined ||
    author.type !== "User" ||
    author.login.toLowerCase() === `${BOT_NAME.toLowerCase()}[bot]`
  );
};

/**
 * GitHub mentions from verified maintainers of the configured repository only.
 *
 * @remarks
 * The root agent has shared Linear and Resend authority. A role in another
 * repository, or the webhook's historical author_association, does not grant
 * access. Permission lookup failures deny dispatch. Automatic PR summaries
 * stay disabled pending an isolated read-only agent and bounded publisher.
 */
export default githubChannel({
  botName: BOT_NAME,
  credentials: connectGitHubCredentials(
    process.env.GITHUB_CONNECTOR ?? "github/kody-agent"
  ),
  onComment: async (ctx, comment) => {
    if (
      isIgnoredComment(comment) ||
      !MENTION_PATTERN.test(comment.body) ||
      `${ctx.repository.owner}/${ctx.repository.name}`.toLowerCase() !==
        digestRepo ||
      comment.author?.id !== ctx.sender.id ||
      ctx.sender.type !== "User"
    ) {
      return null;
    }
    try {
      const { body } = await ctx.github.request<{
        permission?: string;
        user?: { id?: number };
      }>({
        method: "GET",
        path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/collaborators/${encodeURIComponent(ctx.sender.login)}/permission`,
      });
      return body.user?.id === ctx.sender.id &&
        MAINTAINER_PERMISSIONS.has(body.permission ?? "")
        ? { auth: defaultGitHubAuth(ctx) }
        : null;
    } catch {
      return null;
    }
  },
});
