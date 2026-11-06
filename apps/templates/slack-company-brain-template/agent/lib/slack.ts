import { connectSlackCredentials } from "@vercel/connect/eve";

// SLACK_CONNECTOR is provisioned by `eve add channel/slack` or the "Deploy with
// Vercel" button. To create one yourself, run
// `vercel connect create slack --triggers` and put its UID in SLACK_CONNECTOR.
export const slackCredentials = connectSlackCredentials(
  process.env.SLACK_CONNECTOR ?? "slack/company-brain",
);

// When SLACK_TEAM_ID is set, only members of that workspace can reach the agent.
// Slack Connect channels can deliver messages from people in other companies,
// and a company brain usually should not answer them.
export const homeTeamId = process.env.SLACK_TEAM_ID?.trim() || undefined;

export function isHomeTeam(teamId: string | undefined): boolean {
  return homeTeamId === undefined || teamId === homeTeamId;
}
