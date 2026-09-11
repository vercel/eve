import type { SlackLinkRecord } from "../../shared/types/slack-link.js";
import { appOrigin, internalHeaders } from "./internal-api.js";

export async function fetchSlackLinkForMember(teamId: string, userId: string) {
  const response = await fetch(
    `${appOrigin()}/api/internal/slack/link/member?teamId=${encodeURIComponent(teamId)}&userId=${encodeURIComponent(userId)}`,
    { headers: internalHeaders() },
  );

  if (!response.ok) {
    return undefined;
  }

  const body = (await response.json()) as { link: SlackLinkRecord | null };
  return body.link ?? undefined;
}

export async function consumeSlackLinkCodeRemote(input: {
  code: string;
  slackTeamId: string;
  slackUserId: string;
  slackUserName?: string;
  slackDisplayName?: string;
  slackEmail?: string;
}) {
  const response = await fetch(`${appOrigin()}/api/internal/slack/link/consume`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    return { ok: false as const, reason: "invalid" as const };
  }

  return response.json() as Promise<
    { ok: true; appUserId: string } | { ok: false; reason: "invalid" | "expired" }
  >;
}

export function parseSlackLinkCommand(text: string) {
  const match = text.match(/\blink\s+([A-Z0-9]{6})\b/i);
  return match?.[1]?.toUpperCase();
}
