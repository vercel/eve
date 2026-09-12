const TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

export interface ChatGptToken {
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly expiresAt?: number;
  readonly token: string;
}

export interface ChatGptTokenResolutionInput {
  readonly forceRefresh: boolean;
  readonly now: () => number;
}

export class ChatGptSignedOutError extends Error {}

export function isChatGptTokenFresh(token: ChatGptToken | undefined, now: number): boolean {
  return (
    token !== undefined &&
    (token.expiresAt === undefined || token.expiresAt - TOKEN_REFRESH_WINDOW_MS > now)
  );
}
