import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const GITHUB_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/github.ts": `import {
  callGitHubApi,
  githubChannel,
  type GitHubApiResponse,
  type GitHubRequestOptions,
  type GitHubCheckRunEvent,
  type GitHubCheckSuiteEvent,
  type GitHubWorkflowRunEvent,
} from "eve/channels/github";

const ignore = <T>(_event: T): null => null;
const requestOptions: GitHubRequestOptions = { auth: false };
const repoRequest: Promise<GitHubApiResponse<{ readonly id: number }>> = callGitHubApi({
  method: "GET",
  path: "/repos/vercel/eve",
  options: requestOptions,
});
void repoRequest;

export default githubChannel({
  botName: "testbot",
  onCheckRun: (_ctx, checkRun) => ignore<GitHubCheckRunEvent>(checkRun),
  onCheckSuite: (_ctx, checkSuite) => ignore<GitHubCheckSuiteEvent>(checkSuite),
  onWorkflowRun: (_ctx, workflowRun) => ignore<GitHubWorkflowRunEvent>(workflowRun),
});
`,
  },
  name: "github-route-portability",
};
