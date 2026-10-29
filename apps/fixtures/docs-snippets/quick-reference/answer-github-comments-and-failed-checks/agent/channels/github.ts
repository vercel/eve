import { defaultGitHubAuth, githubChannel } from "eve/channels/github";

export default githubChannel({
  botName: "my-agent",
  credentials: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  },
  onCheckSuite: (ctx, suite) =>
    suite.action === "completed" &&
    suite.conclusion === "failure" &&
    suite.app.slug === "github-actions" &&
    suite.pullRequests.length > 0
      ? {
          auth: defaultGitHubAuth(ctx),
          context: [`Check suite ${suite.checkSuiteId} failed at ${suite.headSha}.`],
        }
      : null,
});
