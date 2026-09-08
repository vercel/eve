import type { AuthFn } from "eve/channels/auth";
import { slackChannel, type SlackEvent } from "eve/channels/slack";
import { requiredSignIn } from "../auth/required-sign-in";
import { connectSlackCredentials } from "@vercel/connect/eve";

function eventString(event: SlackEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function senderKey(event: SlackEvent): string | null {
  const userId = eventString(event, "user");
  if (userId === undefined) return null;
  return `${eventString(event, "team") ?? "unknown-workspace"}:${userId}`;
}

const interactiveProfileAuth: AuthFn<SlackEvent> = (event) => {
  const key = senderKey(event);
  if (key === null) return null;
  return requiredSignIn(`slack:${key}`);
};

export default slackChannel({
  credentials: connectSlackCredentials("slack/aap-v"),
  auth: interactiveProfileAuth,
});
