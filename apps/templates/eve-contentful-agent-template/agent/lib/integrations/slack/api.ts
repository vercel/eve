import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";

/** External Slack operations, shared by channels and visualizations. */
export const slackApi = {
  credentials: connectSlackCredentials,
  request: callSlackApi,
};
