import { CONNECT_USER_ISSUER } from "#shared/connect";

export function buildAppSessionAuth(
  appUserId: string,
  attributes: Record<string, string | undefined>,
) {
  const cleaned = Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string] => !!entry[1]),
  );

  return {
    attributes: cleaned,
    authenticator: CONNECT_USER_ISSUER,
    issuer: CONNECT_USER_ISSUER,
    principalId: appUserId,
    principalType: "user",
  };
}
