import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";

// A CI triage agent from an empty workspace. It covers the GitHub channel, a prepared
// Vercel Sandbox, a subagent sharing its parent's sandbox, and agent-wide hooks, which
// the other cases leave out. Each requirement is graded by its own check. The prompt
// states outcomes rather than mechanisms, so the agent has to pick the eve feature itself.
export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "mender",
  timeoutSeconds: 1800,
  // The eval sandbox has no Vercel credentials to prepare the Vercel Sandbox snapshot with.
  skipSandboxPrewarm: true,
  async interact({ send }) {
    await send(
      [
        "Build me an eve agent in a new `mender` project. Mender's job is to keep CI green on Pinecone Labs' `pinecone-labs/ledger`, a TypeScript monorepo on pnpm 9 and Vitest.",
        "",
        "Right now a red PR sits until somebody notices, and then that person spends an hour working out whether it's their change or one of our flaky tests. I want Mender to pick that up on its own as soon as GitHub Actions checks fail on a PR, work out what broke, and say so on the PR. People should also be able to pull it in by writing `@mender` in any issue or PR comment. We run CircleCI for deploy previews too; those failures aren't Mender's problem, and neither are green runs. It should act as our own GitHub App, whose credentials are in `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`.",
        "",
        "To know what broke, it has to actually run our tests, so give it a Vercel Sandbox. Our suite times out on anything under 4 vCPUs, so match that. And don't make every session spend a minute installing pnpm 9 before it can do anything; it should already be there.",
        "",
        "Half our red builds are flakes, so when Mender suspects a test, it should hand it to a `flake-hunter` agent that reruns just that test enough times to call it flaky or a real regression. Flake-hunter should work in the checkout Mender already has instead of setting up the PR again.",
        "",
        'Two asks from our platform team. They chart every agent turn, so after each turn, POST `{ "sessionId", "turnId", "outcome" }` as JSON to `https://metrics.pinecone.dev/v1/agent-turns` with the bearer token in `METRICS_TOKEN`. That service goes down sometimes, and when it does, Mender should carry on as if nothing happened. They also watch the sandbox bill: Mender can sit idle for hours between comments, so don\'t leave compute running once it\'s done responding.',
        "",
        "I don't have Vercel credentials on this machine; CI builds the sandbox snapshot when it deploys. Make sure the project typechecks and compiles anyway, without changing how CI builds it.",
      ].join("\n"),
    );
  },
});
