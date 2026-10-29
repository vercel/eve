import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";

import { GITHUB_CONNECTOR } from "../lib/github";

// The invocation token, usually your GitHub App's slug: `@coding-agent fix this`.
const botName = process.env.GITHUB_BOT_NAME || "coding-agent";
const mention = new RegExp(`@${botName}(?![\\w-])`, "i");

// The agent can push code, so only people with standing in the repository
// can start a turn. Anyone else's comments are ignored.
const trusted = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export default githubChannel({
  botName,
  credentials: connectGitHubCredentials(GITHUB_CONNECTOR),
  onComment: (ctx, comment) =>
    mention.test(comment.body) && trusted.has(String(comment.raw.author_association))
      ? { auth: defaultGitHubAuth(ctx) }
      : null,
});
