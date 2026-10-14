import { connectGitHubCredentials } from "@vercel/connect/eve";
import { githubChannel } from "eve/channels/github";

import { GITHUB_CONNECTOR } from "../lib/github";
import { operatorComments } from "../lib/github-operators";

// The invocation token, usually your GitHub App's slug: `@coding-agent fix this`.
const botName = process.env.GITHUB_BOT_NAME || "coding-agent";
export default githubChannel({
  botName,
  credentials: connectGitHubCredentials(GITHUB_CONNECTOR),
  onComment: operatorComments(botName),
});
