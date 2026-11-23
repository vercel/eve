import selfImprovement from "@eve/self-improvement";

// Replace the example values and complete the setup at https://eve.dev/docs/extensions/self-improvement before deploying.
export default selfImprovement({
  instance: "support",
  project: {
    teamId: "team_YOUR_TEAM_ID",
    projectId: "prj_YOUR_PROJECT_ID",
    productionUrl: "https://your-agent.example.com",
  },
  repository: { owner: "your-org", name: "your-agent", branch: "main" },
  owner: { authenticator: "your-authenticator", principalId: "your-owner-id" },
  models: {
    analyst: "openai/gpt-6.1-sol-fast",
    maintainer: "openai/gpt-6.1-sol",
  },
  cron: "0 10 * * *",
});
