export interface SlackLinkRecord {
  appUserId: string;
  slackTeamId: string;
  slackUserId: string;
  slackUserName?: string;
  slackDisplayName?: string;
  slackEmail?: string;
  linkedAt: string;
}

export interface SlackLinkSummary {
  linked: boolean;
  teamId?: string;
  userId?: string;
  userName?: string;
  displayName?: string;
  email?: string;
  linkedAt?: string;
  pendingCode?: string;
  pendingExpiresAt?: string;
}
