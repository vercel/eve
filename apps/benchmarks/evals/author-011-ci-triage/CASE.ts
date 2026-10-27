import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";

// A CI triage agent from an empty workspace. It covers the GitHub channel, a prepared
// Vercel Sandbox, a subagent sharing its parent's sandbox, and agent-wide hooks, which
// the other cases leave out. Each requirement is graded by its own check.
export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "mender",
  timeoutSeconds: 1800,
  // The eval sandbox has no Vercel credentials to prepare the Vercel Sandbox snapshot with.
  skipSandboxPrewarm: true,
  async interact({ send }) {
    await send(
      [
        "Build me an eve agent in a new `mender` project. Mender keeps CI green on Pinecone Labs' `pinecone-labs/ledger` repository, a TypeScript monorepo that uses pnpm 9 and Vitest.",
        "",
        "- It works in GitHub through our own GitHub App. The app's credentials are in `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`. People ask it for help by writing `@mender` in an issue or pull request comment.",
        "- When a GitHub Actions check suite fails on a pull request, Mender should start triaging that PR on its own, without anyone asking. Passing suites and suites from other CI apps don't need it.",
        "- It reproduces failures by running our tests, so it works in a Vercel Sandbox. Every sandbox should start with pnpm 9 already installed rather than installing it each session, and our test suite is heavy, so give each one 4 vCPUs.",
        "- Add a `flake-hunter` subagent that Mender can hand a failing test to. It reruns that test many times to tell a flaky test from a real regression, working in Mender's own checkout of the PR rather than an empty sandbox of its own.",
        '- Report every finished turn to our metrics service: POST JSON `{ "sessionId", "turnId", "outcome" }` to `https://metrics.pinecone.dev/v1/agent-turns` with the bearer token in `METRICS_TOKEN`. Metrics are best effort, so a metrics outage must never fail Mender\'s work.',
        "- Stop the sandbox when each turn finishes, so we don't pay for idle compute between comments.",
        "",
        "This machine has no Vercel credentials; the sandbox snapshot gets built when CI deploys. Make sure the project typechecks and compiles anyway, without changing how CI builds it.",
      ].join("\n"),
    );
  },
});
