import type { ConnectTokenParams, ConnectTokenSubject } from "@vercel/connect";

export const googleWorkspaceScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/contacts.readonly",
] as const;

export function googleWorkspaceSubject(userId: string): ConnectTokenSubject {
  return { id: userId, issuer: "openinstinct", type: "user" };
}

export function googleWorkspaceTokenParams(userId: string): ConnectTokenParams {
  return {
    scopes: [...googleWorkspaceScopes],
    subject: googleWorkspaceSubject(userId),
  };
}
